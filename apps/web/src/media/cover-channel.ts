/**
 * 封面经 WebRTC DataChannel 发送（Phase 4，D-016）。
 * 房主 ↔ 成员 P2P，Relay 不接触媒体数据。JSON 文本帧：
 *   {kind:"cover-meta",  trackId, mime, totalChunks, size}
 *   {kind:"cover-chunk", trackId, seq(0-based), data(base64)}
 * 每帧原始字节 ≤ CHUNK_BYTES（48KB），规避 SCTP 单消息大小限制。
 */

export const COVER_MAX_BYTES = 512 * 1024;
export const COVER_CHUNK_BYTES = 48 * 1024;
export const COVER_CHANNEL_LABEL = "listo-data";

export interface CoverMeta {
  kind: "cover-meta";
  trackId: string;
  mime: string;
  totalChunks: number;
  size: number;
}

export interface CoverChunk {
  kind: "cover-chunk";
  trackId: string;
  seq: number;
  data: string;
}

export type CoverMessage = CoverMeta | CoverChunk;

// ---- 分块与重组（纯函数，单测覆盖） ----

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/** 把封面字节切成 meta + chunks；空字节返回 null（无需发送）。 */
export function chunkCover(
  trackId: string,
  mime: string,
  bytes: Uint8Array,
  chunkBytes = COVER_CHUNK_BYTES,
): { meta: CoverMeta; chunks: CoverChunk[] } | null {
  if (bytes.length === 0) return null;
  const totalChunks = Math.ceil(bytes.length / chunkBytes);
  const meta: CoverMeta = { kind: "cover-meta", trackId, mime, totalChunks, size: bytes.length };
  const chunks: CoverChunk[] = [];
  for (let seq = 0; seq < totalChunks; seq++) {
    const slice = bytes.subarray(seq * chunkBytes, Math.min((seq + 1) * chunkBytes, bytes.length));
    chunks.push({ kind: "cover-chunk", trackId, seq, data: bytesToBase64(slice) });
  }
  return { meta, chunks };
}

// ---- 接收端组装器（每通道一个） ----

export class CoverAssembler {
  private meta: CoverMeta | null = null;
  private parts = new Map<number, Uint8Array>();

  constructor(private readonly onAssembled: (trackId: string, mime: string, bytes: Uint8Array) => void) {}

  /** 处理一条消息；返回是否被接受。收齐后回调并自动重置。 */
  handle(message: unknown): boolean {
    if (typeof message !== "object" || message === null) return false;
    const msg = message as Record<string, unknown>;
    if (msg.kind === "cover-meta") {
      const meta = msg as unknown as CoverMeta;
      if (typeof meta.trackId !== "string" || meta.totalChunks <= 0 || meta.size > COVER_MAX_BYTES) return false;
      this.meta = meta;
      this.parts.clear();
      return true;
    }
    if (msg.kind === "cover-chunk") {
      const chunk = msg as unknown as CoverChunk;
      if (!this.meta || chunk.trackId !== this.meta.trackId) return false;
      if (this.parts.has(chunk.seq)) return true; // 重复忽略
      const bytes = base64ToBytes(chunk.data);
      this.parts.set(chunk.seq, bytes);
      if (this.parts.size >= this.meta.totalChunks) {
        const total = this.meta.size;
        const mime = this.meta.mime;
        const trackId = this.meta.trackId;
        const merged = new Uint8Array(total);
        let offset = 0;
        for (let seq = 0; seq < this.meta.totalChunks; seq++) {
          const part = this.parts.get(seq);
          if (!part) return false; // 缺块（不应发生：seq 连续收集）
          merged.set(part, offset);
          offset += part.length;
        }
        this.meta = null;
        this.parts.clear();
        this.onAssembled(trackId, mime, merged);
      }
      return true;
    }
    return false;
  }
}

// ---- 发送端压缩（canvas 不可用时跳过；决策纯函数可测） ----

/** 质量阶梯：压缩到 ≤maxBytes 为止；全部失败返回 null（放弃发送，成员显示占位）。 */
export function pickJpegQuality(qualities: number[], sizeFor: (quality: number) => number, maxBytes: number): number | null {
  for (const q of qualities) {
    if (sizeFor(q) <= maxBytes) return q;
  }
  return null;
}

/** 把 Blob 压缩到 ≤maxBytes（canvas 缩放 + JPEG 质量递减）；环境不支持时返回原 Blob。 */
export async function compressCoverBlob(
  blob: Blob,
  maxBytes = COVER_MAX_BYTES,
  maxDimension = 512,
): Promise<Blob | null> {
  if (blob.size <= maxBytes) return blob;
  if (typeof createImageBitmap === "undefined" || typeof document === "undefined") return null;
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const qualities = [0.85, 0.7, 0.5];
    for (const q of qualities) {
      const out = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", q));
      if (out && out.size <= maxBytes) return out;
    }
    return null;
  } catch {
    return null;
  }
}

// ---- 接收端缓存（可观察 LRU，UI 订阅显示） ----

export interface CoverEntry {
  url: string;
  mime: string;
}

/** 按 trackId 的封面缓存（内存 LRU）；对象 URL 由本 store 创建与回收。 */
export class CoverStore {
  private entries = new Map<string, CoverEntry>();
  private listeners = new Set<() => void>();

  constructor(private readonly capacity = 20) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get(trackId: string | null | undefined): CoverEntry | null {
    if (!trackId) return null;
    return this.entries.get(trackId) ?? null;
  }

  /** 收到完整封面后放入；重复 trackId 覆盖。 */
  put(trackId: string, mime: string, bytes: Uint8Array): void {
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mime });
    const url = URL.createObjectURL(blob);
    const prev = this.entries.get(trackId);
    if (prev) URL.revokeObjectURL(prev.url);
    this.entries.delete(trackId);
    this.entries.set(trackId, { url, mime });
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      const old = this.entries.get(oldest);
      if (old) URL.revokeObjectURL(old.url);
      this.entries.delete(oldest);
    }
    for (const listener of this.listeners) listener();
  }

  dispose(): void {
    for (const entry of this.entries.values()) URL.revokeObjectURL(entry.url);
    this.entries.clear();
    this.listeners.clear();
  }
}

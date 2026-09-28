/**
 * 可定位音频源的 AudioBuffer 实现（packages/media 的 LocatableAudioSource，Phase 2 落地）。
 * 房主本地文件在这里解码；缓冲支持随机访问，重新同步时按目标位置重建音频段。
 */
import type { LocatableAudioSource } from "@listogether/media";

export interface DecodedTrackMeta {
  trackId: string;
  title: string;
  durationMs: number;
}

export interface DecodedTrack {
  buffer: AudioBuffer;
  meta: DecodedTrackMeta;
}

/** 解码本地文件；title 取文件名去扩展名。decodeAudioData 失败时抛出原始错误。 */
export async function decodeAudioFile(file: File, ctx: BaseAudioContext): Promise<DecodedTrack> {
  const bytes = await file.arrayBuffer();
  const buffer = await ctx.decodeAudioData(stripId3v2(bytes));
  const title = file.name.replace(/\.[^.]+$/, "").trim() || "本地音频";
  return {
    buffer,
    meta: {
      trackId: `local-${Date.now().toString(16)}-${randomSuffix()}`,
      title,
      durationMs: Math.round(buffer.duration * 1000),
    },
  };
}

/**
 * 剥离文件头部的 ID3v2 标签（E2E 实测：Chrome 的 decodeAudioData 对带 ID3 前缀的
 * WAV 等非 MP3 容器直接解码失败；MP3 自身可解析）。无 ID3v2 头时原样返回。
 */
export function stripId3v2(bytes: ArrayBuffer): ArrayBuffer {
  const view = new DataView(bytes);
  if (bytes.byteLength < 10) return bytes;
  if (view.getUint8(0) !== 0x49 || view.getUint8(1) !== 0x44 || view.getUint8(2) !== 0x33) return bytes; // "ID3"
  const major = view.getUint8(3);
  if (major < 2 || major > 4) return bytes;
  const flags = view.getUint8(5);
  // synchsafe 大小：4 字节每字节低 7 位
  let size = (view.getUint8(6) & 0x7f) << 21 | (view.getUint8(7) & 0x7f) << 14 | (view.getUint8(8) & 0x7f) << 7 | view.getUint8(9) & 0x7f;
  // footer 位（flags bit4）：tag 尾部还有 10 字节 footer
  if (flags & 0x10) size += 10;
  if (size <= 0 || 10 + size > bytes.byteLength) return bytes;
  return bytes.slice(10 + size);
}

/** 把 clamp 后的位置换算为 AudioBufferSourceNode.start 的偏移（秒）。 */
export function bufferOffsetSec(positionMs: number, durationMs: number): number {
  const clamped = Math.min(Math.max(0, positionMs), Math.max(0, durationMs));
  return clamped / 1000;
}

/** LocatableAudioSource 实现：定位记录偏移，connectTo 产出已挂缓冲的源节点（由调用方 start）。 */
export class BufferLocatableSource implements LocatableAudioSource {
  private offsetMs: number;
  private released = false;

  constructor(
    private readonly buffer: AudioBuffer,
    initialPositionMs = 0,
  ) {
    this.offsetMs = clampMs(initialPositionMs, this.durationOf(buffer));
  }

  private durationOf(buffer: AudioBuffer): number {
    return Math.round(buffer.duration * 1000);
  }

  get durationMs(): number {
    return this.released ? 0 : this.durationOf(this.buffer);
  }

  /** 当前定位（毫秒）。 */
  get positionMs(): number {
    return this.released ? 0 : this.offsetMs;
  }

  seekTo(positionMs: number): Promise<void> {
    if (!this.released) {
      this.offsetMs = clampMs(positionMs, this.durationOf(this.buffer));
    }
    return Promise.resolve();
  }

  /** 产出已挂载缓冲的 AudioBufferSourceNode；start(when, offset) 由调用方调度。 */
  connectTo(context: BaseAudioContext): AudioNode {
    if (this.released) throw new Error("音频源已释放，不可复用");
    const node = context.createBufferSource();
    node.buffer = this.buffer;
    return node;
  }

  release(): void {
    this.released = true;
  }
}

function clampMs(value: number, durationMs: number): number {
  const safe = Number.isFinite(value) ? value : 0;
  return Math.min(Math.max(0, safe), Math.max(0, durationMs));
}

function randomSuffix(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

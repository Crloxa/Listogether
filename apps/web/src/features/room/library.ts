/**
 * 房主曲库（Phase 3，D-012）：
 * - trackId 由文件名+大小+修改时间哈希生成，是曲库条目、队列条目与本地文件的绑定标识；
 * - mp3 解析 ID3v2 标签（标题/艺人/封面），其余格式回退文件名（封面不进协议，只在本机显示）；
 * - 曲库元数据持久化到 localStorage（不含文件字节）；刷新后条目为“未加载”，
 *   重新选择同名同大小文件时绑定回原 trackId，已有队列请求不失效；
 * - 导入导出最小 JSON 格式。
 */
import type { LibraryEntry, Track, TrackSource } from "@listogether/protocol";

export const LIBRARY_STORAGE_KEY = "listogether:library:v1";
export const LYRICS_STORAGE_KEY = "listogether:lyrics:v1";
export const LIBRARY_EXPORT_VERSION = 1;

/** 房主本机曲库条目：元数据 + 可能为空的本地文件引用。 */
export interface HostLibraryEntry {
  trackId: string;
  title: string;
  artist: string;
  durationMs: number;
  addedAtMs: number;
  file: File | null;
  /** 持久化记录的文件名/大小（file 为空时用于重新绑定同名文件）。 */
  storedFile: { name: string; size: number } | null;
  coverUrl: string | null;
  /** 封面原始字节（D-016 经 DataChannel 发送用）；不持久化。 */
  coverBlob?: Blob | null;
  /** 平台链接来源（D-014）；本地文件条目为 null。 */
  source?: TrackSource | null;
}

/** 本机歌词缓存条目（D-017）。 */
export interface StoredLyrics {
  format: "lrc" | "plain";
  text: string;
}

export interface LibraryExport {
  version: number;
  tracks: Array<{
    trackId: string;
    title: string;
    artist?: string;
    durationMs: number;
    file: { name: string; size: number };
  }>;
}

/** 文件名去扩展名；空名回退“本地音频”。 */
export function fileTitle(name: string): string {
  return name.replace(/\.[^.]+$/, "").trim() || "本地音频";
}

/** FNV-1a 32 位哈希（十六进制）；用于从文件元数据生成稳定 trackId。 */
export function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** 由文件元数据生成 trackId：同名同大小同修改时间的文件视为同一首。 */
export function makeTrackId(file: { name: string; size: number; lastModified: number }): string {
  return `local-${fnv1aHex(`${file.name}\u0000${file.size}\u0000${file.lastModified}`)}`;
}

/** “未加载”条目的再绑定键：同名同大小即视为同一文件（修改时间变化不破坏绑定）。 */
export function fileBindingKey(file: { name: string; size: number }): string {
  return `${file.name}\u0000${file.size}`;
}

/** 条目的绑定键：优先实际文件，其次持久化记录。 */
export function entryBindingKey(entry: HostLibraryEntry): string | null {
  if (entry.file) return fileBindingKey(entry.file);
  if (entry.storedFile) return fileBindingKey(entry.storedFile);
  return null;
}

// ---- ID3v2 最小解析（v2.3/2.4：TIT2/TPE1/TALB/APIC） ----

export interface Id3Tags {
  title?: string;
  artist?: string;
  coverBlob?: Blob;
}

interface Id3Frame {
  id: string;
  data: Uint8Array;
}

const ID3_TEXT_ENCODINGS = { LATIN1: 0, UTF16: 1, UTF16BE: 2, UTF8: 3 } as const;

function decodeText(bytes: Uint8Array, encoding: number): string {
  try {
    switch (encoding) {
      case ID3_TEXT_ENCODINGS.UTF16:
        return new TextDecoder("utf-16").decode(bytes);
      case ID3_TEXT_ENCODINGS.UTF16BE:
        return new TextDecoder("utf-16be").decode(bytes);
      case ID3_TEXT_ENCODINGS.UTF8:
        return new TextDecoder("utf-8").decode(bytes);
      default:
        return new TextDecoder("latin1").decode(bytes);
    }
  } catch {
    return "";
  }
}

function stripNulls(text: string): string {
  return text.replace(/\u0000+$/g, "").trim();
}

/** synchsafe 整数：4 字节，每字节仅低 7 位有效。 */
function readSyncsafe(b: Uint8Array, offset: number): number {
  return (
    ((byteAt(b, offset) & 0x7f) << 21) |
    ((byteAt(b, offset + 1) & 0x7f) << 14) |
    ((byteAt(b, offset + 2) & 0x7f) << 7) |
    (byteAt(b, offset + 3) & 0x7f)
  );
}

function readUint32(b: Uint8Array, offset: number): number {
  return (
    (byteAt(b, offset) << 24) | (byteAt(b, offset + 1) << 16) | (byteAt(b, offset + 2) << 8) | byteAt(b, offset + 3)
  );
}

/** 越界安全读取（严格索引模式下保持解析循环简洁）。 */
function byteAt(b: Uint8Array, offset: number): number {
  return offset >= 0 && offset < b.length ? (b[offset] as number) : 0;
}

function parseFrames(body: Uint8Array, id3v24: boolean): Id3Frame[] {
  const frames: Id3Frame[] = [];
  let offset = 0;
  while (offset + 10 <= body.length) {
    const id = String.fromCharCode(byteAt(body, offset), byteAt(body, offset + 1), byteAt(body, offset + 2), byteAt(body, offset + 3));
    if (!/^[A-Z0-9]{4}$/.test(id)) break; // padding 或损坏
    const size = id3v24 ? readSyncsafe(body, offset + 4) : readUint32(body, offset + 4);
    if (size <= 0 || offset + 10 + size > body.length) break;
    frames.push({ id, data: body.subarray(offset + 10, offset + 10 + size) });
    offset += 10 + size;
  }
  return frames;
}

function parseTextFrame(data: Uint8Array): string {
  if (data.length < 1) return "";
  return stripNulls(decodeText(data.subarray(1), byteAt(data, 0)));
}

/** 解析 APIC 帧（嵌入封面）。v2.3 与 v2.4 的二进制布局一致。 */
function parseApicFrame(data: Uint8Array): Blob | undefined {
  if (data.length < 4) return undefined;
  const encoding = byteAt(data, 0);
  let offset = 1;
  // MIME：latin1 以 \0 结尾
  let mimeEnd = offset;
  while (mimeEnd < data.length && byteAt(data, mimeEnd) !== 0) mimeEnd++;
  const mime = decodeText(data.subarray(offset, mimeEnd), 0) || "image/jpeg";
  offset = mimeEnd + 1;
  if (offset >= data.length) return undefined;
  offset += 1; // picture type
  // description：按编码找终止符（UTF-16 为双字节 \0）
  if (encoding === ID3_TEXT_ENCODINGS.UTF16 || encoding === ID3_TEXT_ENCODINGS.UTF16BE) {
    while (offset + 1 < data.length && !(byteAt(data, offset) === 0 && byteAt(data, offset + 1) === 0)) offset += 2;
    offset += 2;
  } else {
    while (offset < data.length && byteAt(data, offset) !== 0) offset++;
    offset += 1;
  }
  if (offset >= data.length) return undefined;
  const bytes = data.slice(offset);
  return new Blob([bytes], { type: mime.startsWith("image/") ? mime : "image/jpeg" });
}

/** 解析文件头部数据中的 ID3v2 标签；无标签/损坏时返回空对象。 */
export function parseId3Tags(head: ArrayBuffer): Id3Tags {
  const b = new Uint8Array(head);
  if (b.length < 10 || byteAt(b, 0) !== 0x49 || byteAt(b, 1) !== 0x44 || byteAt(b, 2) !== 0x33) return {};
  const major = byteAt(b, 3);
  if (major !== 3 && major !== 4) return {};
  const tagSize = readSyncsafe(b, 6);
  const body = b.subarray(10, Math.min(10 + tagSize, b.length));
  const tags: Id3Tags = {};
  for (const frame of parseFrames(body, major === 4)) {
    if (frame.id === "TIT2" && !tags.title) tags.title = parseTextFrame(frame.data);
    if (frame.id === "TPE1" && !tags.artist) tags.artist = parseTextFrame(frame.data);
    if (frame.id === "APIC" && !tags.coverBlob) tags.coverBlob = parseApicFrame(frame.data);
  }
  return tags;
}

/** 读取文件头部并解析 ID3 标签（只读前 2MB，避免整文件读取）。 */
export async function readId3Tags(file: File): Promise<Id3Tags> {
  try {
    const head = await file.slice(0, 2 * 1024 * 1024).arrayBuffer();
    return parseId3Tags(head);
  } catch {
    return {};
  }
}

// ---- FLAC / MP4(M4A) 标签解析（D-020）：按文件头分派，8MB 读取预算，不引入依赖 ----

const TAG_READ_LIMIT = 8 * 1024 * 1024;

/**
 * 统一标签入口：按文件头魔数分派——"fLaC" → FLAC；偏移 4 的 "ftyp" → MP4/M4A；
 * 其余（含 mp3 的 "ID3" 与 wav 的 ID3 前缀）走 ID3 解析。解析失败一律返回空对象（回退文件名）。
 */
export async function readAudioTags(file: File): Promise<Id3Tags> {
  try {
    const head = await file.slice(0, TAG_READ_LIMIT).arrayBuffer();
    const b = new Uint8Array(head);
    if (b.length >= 4 && b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43) {
      return parseFlacTags(head);
    }
    if (b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
      return parseMp4Tags(head);
    }
    return parseId3Tags(head);
  } catch {
    return {};
  }
}

function asciiAt(b: Uint8Array, start: number, len: number): string {
  let out = "";
  for (let i = 0; i < len && start + i < b.length; i++) out += String.fromCharCode(b[start + i]!);
  return out;
}

function u32be(b: Uint8Array, off: number): number {
  if (off + 4 > b.length) return 0;
  return ((b[off]! << 24) | (b[off + 1]! << 16) | (b[off + 2]! << 8) | b[off + 3]!) >>> 0;
}

function u32le(b: Uint8Array, off: number): number {
  if (off + 4 > b.length) return 0;
  return ((b[off + 3]! << 24) | (b[off + 2]! << 16) | (b[off + 1]! << 8) | b[off]!) >>> 0;
}

/** FLAC METADATA_BLOCK 遍历：type 4 = VORBIS_COMMENT（标题/艺人），type 6 = PICTURE（封面）。 */
export function parseFlacTags(buffer: ArrayBuffer): Id3Tags {
  const b = new Uint8Array(buffer);
  const tags: Id3Tags = {};
  if (b.length < 8 || b[0] !== 0x66 || b[1] !== 0x4c || b[2] !== 0x61 || b[3] !== 0x43) return tags;
  let off = 4;
  while (off + 4 <= b.length) {
    const header = b[off]!;
    const last = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const len = ((b[off + 1]! << 16) | (b[off + 2]! << 8) | b[off + 3]!) >>> 0;
    const contentStart = off + 4;
    const contentEnd = Math.min(contentStart + len, b.length);
    if (type === 4) parseVorbisComment(b.subarray(contentStart, contentEnd), tags);
    else if (type === 6 && !tags.coverBlob) tags.coverBlob = parseFlacPicture(b.subarray(contentStart, contentEnd));
    if (last) break;
    off = contentEnd;
  }
  return tags;
}

/** VORBIS_COMMENT：小端 u32；条目形如 "KEY=value"，取 TITLE/ARTIST（大小写不敏感，首个生效）。 */
function parseVorbisComment(b: Uint8Array, tags: Id3Tags): void {
  try {
    let p = 4 + u32le(b, 0); // 跳过 vendor
    const count = u32le(b, p);
    p += 4;
    for (let i = 0; i < count && p + 4 <= b.length; i++) {
      const len = u32le(b, p);
      p += 4;
      if (p + len > b.length) break;
      const entry = new TextDecoder("utf-8").decode(b.subarray(p, p + len));
      p += len;
      const eq = entry.indexOf("=");
      if (eq <= 0) continue;
      const key = entry.slice(0, eq).toUpperCase();
      const value = entry.slice(eq + 1).trim();
      if (!value) continue;
      if (key === "TITLE" && !tags.title) tags.title = value;
      if (key === "ARTIST" && !tags.artist) tags.artist = value;
    }
  } catch {
    /* 损坏的 comment 块：保留已解析部分 */
  }
}

/** FLAC PICTURE（大端）：取图片字节与 MIME；非图片 MIME 回退 jpeg。 */
function parseFlacPicture(b: Uint8Array): Blob | undefined {
  try {
    let p = 4; // picture type
    const mimeLen = u32be(b, p);
    const mime = asciiAt(b, p + 4, mimeLen);
    p += 4 + mimeLen;
    const descLen = u32be(b, p);
    p += 4 + descLen;
    p += 16; // width/height/depth/colors
    const dataLen = u32be(b, p);
    p += 4;
    if (dataLen <= 0 || p + dataLen > b.length) return undefined;
    return new Blob([b.slice(p, p + dataLen)], { type: mime.startsWith("image/") ? mime : "image/jpeg" });
  } catch {
    return undefined;
  }
}

/** MP4 atom 遍历：返回首个匹配 type 的内容区间 [start, end)；找不到返回 null。 */
function findAtom(b: Uint8Array, start: number, end: number, type: string): [number, number] | null {
  let off = start;
  while (off + 8 <= end) {
    let size = u32be(b, off);
    const atomType = asciiAt(b, off + 4, 4);
    let headerLen = 8;
    if (size === 1) {
      // 64 位扩展大小（罕见）：读低 32 位足够（>4GB 的单个 atom 不支持）
      if (off + 16 > end) return null;
      size = u32be(b, off + 12);
      headerLen = 16;
    }
    if (size < headerLen) return null;
    const contentStart = off + headerLen;
    const contentEnd = Math.min(off + size, end);
    if (contentStart > end) return null;
    if (atomType === type && contentEnd >= contentStart) return [contentStart, contentEnd];
    off += size;
  }
  return null;
}

/**
 * MP4/M4A ilst 解析：moov → udta → meta（4 字节版本/ flags）→ ilst；
 * 条目 atom 类型即字段名（©nam 标题 / ©ART·aART 艺人 / covr 封面），内含 'data' 子 atom。
 * moov 不在读取预算内（非 faststart 的文件）时按不支持处理，回退文件名。
 */
export function parseMp4Tags(buffer: ArrayBuffer): Id3Tags {
  const b = new Uint8Array(buffer);
  const tags: Id3Tags = {};
  if (b.length < 12) return tags;
  const moov = findAtom(b, 0, b.length, "moov");
  if (!moov) return tags;
  const udta = findAtom(b, moov[0], moov[1], "udta");
  if (!udta) return tags;
  const meta = findAtom(b, udta[0], udta[1], "meta");
  if (!meta) return tags;
  const ilst = findAtom(b, meta[0] + 4, meta[1], "ilst"); // meta 头部含 4 字节 version/flags
  if (!ilst) return tags;

  let off = ilst[0];
  while (off + 8 <= ilst[1]) {
    const size = u32be(b, off);
    if (size < 8) break;
    const itemType = asciiAt(b, off + 4, 4);
    const itemEnd = Math.min(off + size, ilst[1]);
    const data = findAtom(b, off + 8, itemEnd, "data");
    if (data) {
      const typeIndicator = u32be(b, data[0]);
      const payloadStart = data[0] + 8;
      if (itemType === "\u00A9nam" && !tags.title && typeIndicator === 1) {
        tags.title = new TextDecoder("utf-8").decode(b.subarray(payloadStart, data[1])).trim();
      } else if (!tags.artist && typeIndicator === 1 && (itemType === "\u00A9ART" || itemType === "aART")) {
        tags.artist = new TextDecoder("utf-8").decode(b.subarray(payloadStart, data[1])).trim();
      } else if (itemType === "covr" && !tags.coverBlob && payloadStart < data[1]) {
        const mime = typeIndicator === 14 ? "image/png" : "image/jpeg";
        tags.coverBlob = new Blob([b.slice(payloadStart, data[1])], { type: mime });
      }
    }
    off += size;
  }
  return tags;
}

// ---- 持久化与导入导出 ----

interface StoredEntry {
  trackId: string;
  title: string;
  artist?: string;
  durationMs: number;
  addedAtMs: number;
  file: { name: string; size: number };
  source?: TrackSource;
}

/** 序列化为可持久化/导出的形态（不含文件字节与封面；source 保留）。 */
export function toStoredEntries(entries: HostLibraryEntry[]): StoredEntry[] {
  return entries.map((e) => {
    const file = e.file ?? e.storedFile ?? { name: "", size: 0 };
    return {
      trackId: e.trackId,
      title: e.title,
      artist: e.artist || undefined,
      durationMs: e.durationMs,
      addedAtMs: e.addedAtMs,
      file: { name: file.name, size: file.size },
      source: e.source ?? undefined,
    };
  });
}

/** 保存曲库元数据；存储不可用时静默跳过（隐私模式下 localStorage 可能被禁）。 */
export function saveLibrary(storage: Storage | null, entries: HostLibraryEntry[]): void {
  if (!storage) return;
  try {
    storage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(toStoredEntries(entries)));
  } catch {
    /* 配额/不可用：忽略 */
  }
}

/** 读取持久化的曲库元数据；损坏数据返回空并清除。 */
export function loadLibrary(storage: Storage | null): HostLibraryEntry[] {
  if (!storage) return [];
  let raw: string | null = null;
  try {
    raw = storage.getItem(LIBRARY_STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("not array");
    return parsed.map((item) => {
      const e = item as StoredEntry;
      return {
        trackId: e.trackId,
        title: e.title,
        artist: e.artist ?? "",
        durationMs: e.durationMs,
        addedAtMs: e.addedAtMs,
        file: null, // 文件字节无法持久化，需重新绑定
        storedFile: { name: e.file?.name ?? "", size: e.file?.size ?? 0 },
        coverUrl: null,
        coverBlob: null,
        source: e.source ?? null,
      } satisfies HostLibraryEntry;
    });
  } catch {
    try {
      storage.removeItem(LIBRARY_STORAGE_KEY);
    } catch {
      /* 忽略 */
    }
    return [];
  }
}

/** 导出最小 JSON 格式（D-012）。 */
export function exportLibrary(entries: HostLibraryEntry[]): LibraryExport {
  return {
    version: LIBRARY_EXPORT_VERSION,
    tracks: toStoredEntries(entries).map((e) => ({
      trackId: e.trackId,
      title: e.title,
      artist: e.artist,
      durationMs: e.durationMs,
      file: e.file,
    })),
  };
}

/** 解析导入的 JSON；非法输入抛出可展示的错误。 */
export function parseLibraryImport(json: string): LibraryExport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("不是有效的 JSON 文件");
  }
  const data = parsed as LibraryExport;
  if (data?.version !== LIBRARY_EXPORT_VERSION || !Array.isArray(data?.tracks)) {
    throw new Error(`不支持的歌单格式（需要 version ${LIBRARY_EXPORT_VERSION}）`);
  }
  for (const t of data.tracks) {
    if (!t?.trackId || !t?.title || !t?.file?.name) {
      throw new Error("歌单条目缺少必要字段（trackId/title/file.name）");
    }
  }
  return data;
}

/** 导入条目转为未加载的曲库条目（重复 trackId 跳过由调用方合并时处理）。 */
export function importEntriesToHost(data: LibraryExport): HostLibraryEntry[] {
  return data.tracks.map((t) => ({
    trackId: t.trackId,
    title: t.title,
    artist: t.artist ?? "",
    durationMs: t.durationMs ?? 0,
    addedAtMs: Date.now(),
    file: null,
    storedFile: { name: t.file.name, size: t.file.size },
    coverUrl: null,
    coverBlob: null,
    source: null,
  }));
}

/** 曲库条目 → 协议 Track（LIBRARY_ADD 用；平台来源随 source 下发）。 */
export function hostEntryToTrack(entry: HostLibraryEntry): Track {
  return {
    trackId: entry.trackId,
    title: entry.title,
    artist: entry.artist || undefined,
    durationMs: entry.durationMs,
    source: entry.source ?? undefined,
  };
}

/** 房间快照曲库 → 本机曲库视图（补齐本机文件绑定信息）。 */
export function mergeSnapshotLibrary(existing: HostLibraryEntry[], library: LibraryEntry[]): HostLibraryEntry[] {
  const byId = new Map(existing.map((e) => [e.trackId, e]));
  const merged: HostLibraryEntry[] = [];
  for (const entry of library) {
    const local = byId.get(entry.trackId);
    merged.push(
      local ?? {
        trackId: entry.trackId,
        title: entry.title,
        artist: entry.artist ?? "",
        durationMs: entry.durationMs,
        addedAtMs: entry.addedAtMs,
        file: null,
        storedFile: null,
        coverUrl: null,
        coverBlob: null,
        source: entry.source ?? null,
      },
    );
  }
  return merged;
}

// ---- 歌词持久化（D-017，房主本机） ----

/** 保存歌词缓存；存储不可用/超配额静默跳过。 */
export function saveLyricsCache(storage: Storage | null, cache: Map<string, StoredLyrics>): void {
  if (!storage) return;
  try {
    storage.setItem(LYRICS_STORAGE_KEY, JSON.stringify(Object.fromEntries(cache)));
  } catch {
    /* 配额/不可用：忽略 */
  }
}

/** 读取歌词缓存；损坏数据返回空并清除。 */
export function loadLyricsCache(storage: Storage | null): Map<string, StoredLyrics> {
  if (!storage) return new Map();
  let raw: string | null = null;
  try {
    raw = storage.getItem(LYRICS_STORAGE_KEY);
  } catch {
    return new Map();
  }
  if (!raw) return new Map();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) throw new Error("not object");
    const out = new Map<string, StoredLyrics>();
    for (const [trackId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const v = value as StoredLyrics;
      if (typeof v?.text === "string" && (v.format === "lrc" || v.format === "plain")) {
        out.set(trackId, { format: v.format, text: v.text });
      }
    }
    return out;
  } catch {
    try {
      storage.removeItem(LYRICS_STORAGE_KEY);
    } catch {
      /* 忽略 */
    }
    return new Map();
  }
}

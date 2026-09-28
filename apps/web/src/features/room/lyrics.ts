/**
 * 歌词（Phase 4，D-017）：LRC 解析、纯文本格式、发送前校验。
 * 上限与 Relay 端一致：≤48KB 文本、≤500 行、单行 ≤512 字节（防 JSON 转义后撑爆 64KB WS 帧）。
 */
import type { LyricsFormat } from "@listogether/protocol";

export const MAX_LYRICS_BYTES = 48 * 1024;
export const MAX_LYRICS_LINES = 500;
export const MAX_LYRICS_LINE_BYTES = 512;

/** 一行同步歌词。 */
export interface LyricsLine {
  timeMs: number;
  text: string;
}

/** 解析结果：lrc 为时间轴行（按时间排序），plain 为纯文本段。 */
export interface ParsedLyrics {
  format: LyricsFormat;
  lines: LyricsLine[];
}

export class LyricsTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LyricsTooLargeError";
  }
}

/** 发送前校验（与服务端 DecodeTrackLyrics 同规则）；超限抛 LyricsTooLargeError。 */
export function validateLyricsSize(text: string): void {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_LYRICS_BYTES) {
    throw new LyricsTooLargeError("歌词超过 48KB 上限，请精简后再试");
  }
  const lines = text.split("\n");
  if (lines.length > MAX_LYRICS_LINES) {
    throw new LyricsTooLargeError("歌词超过 500 行上限");
  }
  for (const line of lines) {
    if (new TextEncoder().encode(line).length > MAX_LYRICS_LINE_BYTES) {
      throw new LyricsTooLargeError("存在超过 512 字节的单行歌词");
    }
  }
}

/** 按扩展名猜格式；.lrc → lrc，其他（.txt 等）→ plain。 */
export function lyricsFormatForFileName(name: string): LyricsFormat {
  return /\.lrc$/i.test(name) ? "lrc" : "plain";
}

/** 判断文件是否可能是歌词文件（同名匹配用）。 */
export function looksLikeLyricsFile(name: string): boolean {
  return /\.lrc$|\.txt$/i.test(name);
}

/** 去掉扩展名的歌曲名（同名匹配键：小写 + 去空格）。 */
export function lyricsBindingKey(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, "")
    .replaceAll(/\s+/g, "")
    .toLowerCase();
}

/**
 * 解析 LRC 文本：`[mm:ss.xx]`（可多个时间戳/行），忽略元数据标签与空行。
 * 无法解析出任何时间戳时返回 lines=[]（调用方按纯文本降级或提示）。
 */
export function parseLrc(text: string): LyricsLine[] {
  const lines: LyricsLine[] = [];
  const stamp = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;
    // 一行可有多个连续 [mm:ss.xx] 前缀；matchAll 需要全局正则
    const times: number[] = [];
    let lastIndex = 0;
    let broken = false;
    for (const match of line.matchAll(stamp)) {
      if (match.index === undefined || match.index !== lastIndex) {
        broken = true;
        break;
      }
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      const fractionRaw = match[3] ?? "";
      // 小数位按十进制语义：.3 → 300ms、.25 → 250ms、.250 → 250ms
      const fraction = fractionRaw ? Number(fractionRaw) * 10 ** (3 - fractionRaw.length) : 0;
      times.push(minutes * 60_000 + seconds * 1000 + fraction);
      lastIndex = match.index + match[0].length;
    }
    if (broken || times.length === 0) continue; // 元数据标签（[ti:]/[ar:]）或纯文本行
    const textPart = line.slice(lastIndex).trim();
    if (!textPart) continue;
    for (const timeMs of times) {
      lines.push({ timeMs, text: textPart });
    }
  }
  lines.sort((a, b) => a.timeMs - b.timeMs);
  return lines;
}

/** 解析任意格式歌词文本。 */
export function parseLyrics(text: string, format: LyricsFormat): ParsedLyrics {
  if (format === "lrc") {
    const lines = parseLrc(text);
    if (lines.length > 0) return { format: "lrc", lines };
  }
  // 纯文本：非空行按顺序展示
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .map((line, i) => ({ timeMs: i, text: line }));
  return { format: "plain", lines };
}

/** 二分查找当前播放位置对应的行索引；无命中（进度在第一行前）返回 -1。 */
export function currentLyricsLineIndex(lines: LyricsLine[], positionMs: number): number {
  if (lines.length === 0 || positionMs < (lines[0]?.timeMs ?? 0)) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((lines[mid]?.timeMs ?? 0) <= positionMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

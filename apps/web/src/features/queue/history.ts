/**
 * "上一首"选择器（D-020）：从快照 history 中取最近一条可回放条目。
 * 只认 played/skipped（failed/rejected 不回放）。
 * 历史只记录已结束的曲目：播放中时 history[0] 即上一首；
 * 歌曲刚结束/被跳过时 history[0] 就是它自己——重播正是"上一首"的预期语义。
 */
import type { HistoryEntry, Track } from "@listogether/protocol";

export function previousTrackFromHistory(history: HistoryEntry[]): Track | null {
  for (const entry of history) {
    if (entry.outcome !== "played" && entry.outcome !== "skipped") continue;
    return entry.track;
  }
  return null;
}

/** 歌词面板（Phase 4，D-017）：LRC 行级高亮随 livePositionMs 推进；纯文本整段显示；无歌词占位。 */
import { useMemo, useSyncExternalStore } from "react";
import { currentLyricsLineIndex, parseLyrics } from "./lyrics";
import type { RoomStore } from "../../transport/ws/room-store";

export default function LyricsPanel({ store, positionMs }: { store: RoomStore; positionMs: number }) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const lyrics = state.lyrics;
  const parsed = useMemo(() => (lyrics ? parseLyrics(lyrics.lyrics, lyrics.format) : null), [lyrics]);

  // LRC：二分定位当前行；plain：整段（timeMs 无意义，不高亮）
  const activeIndex =
    parsed?.format === "lrc" ? currentLyricsLineIndex(parsed.lines, positionMs) : -1;

  if (!parsed || parsed.lines.length === 0) {
    return (
      <section className="card" data-testid="lyrics-panel">
        <h2>歌词</h2>
        <p className="hint" data-testid="lyrics-placeholder">
          本曲没有歌词。房主可在曲库条目上指定同名 .lrc / .txt 文件。
        </p>
      </section>
    );
  }

  return (
    <section className="card" data-testid="lyrics-panel">
      <h2>歌词{parsed.format === "plain" ? "（纯文本）" : ""}</h2>
      <ol className="lyrics" data-testid="lyrics-lines">
        {parsed.lines.map((line, index) => (
          <li
            key={parsed.format === "lrc" ? line.timeMs + "-" + index : index}
            aria-current={parsed.format === "lrc" && index === activeIndex ? "true" : undefined}
            className={parsed.format === "lrc" && index === activeIndex ? "active" : undefined}
          >
            {line.text}
          </li>
        ))}
      </ol>
    </section>
  );
}

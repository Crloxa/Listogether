/** LibraryPanel：房主本地文件导入与房间曲库（Phase 3，D-012；Phase 4 平台条目/歌词，D-014/D-017）。
 * 拖放文件/文件夹或多选导入；音频只在房主本机解码，成员仅获得元数据与 WebRTC 音频流。
 * 导入失败（格式不支持/损坏）明确提示，不影响其他文件。
 * 平台链接条目（D-014）显示来源徽章与可用性，且提示需要绑定本机文件。 */
import { useRef, useState, type DragEvent } from "react";
import type { RoomStore } from "../../transport/ws/room-store";
import type { HostLibraryApi } from "./use-host-library";
import { describePlayability } from "../providers/normalize";
import { formatMs } from "../../ui/format";

const ACCEPTED_HINT = "支持浏览器可解码的音频格式（mp3/wav/ogg/flac/m4a 等）";

const PLATFORM_BADGE: Record<string, string> = {
  netease: "网易云",
  qqmusic: "QQ 音乐",
  spotify: "Spotify",
  ytmusic: "YT Music",
  other: "平台",
};

export default function LibraryPanel({
  store,
  library,
}: {
  store: RoomStore;
  library: HostLibraryApi;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const importJsonInputRef = useRef<HTMLInputElement>(null);
  const lyricsInputRef = useRef<HTMLInputElement>(null);
  const [lyricsTarget, setLyricsTarget] = useState<string | null>(null);

  async function handleLyricsFile(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    const trackId = lyricsTarget;
    setLyricsTarget(null);
    if (!file || !trackId) return;
    try {
      await library.attachLyrics(trackId, file);
      setNotice(null);
    } catch (err) {
      setNotice((err as Error).message || "歌词文件读取失败");
    }
  }

  /** 拖放条目 → 文件列表；目录用 webkitGetAsEntry 递归展开。 */
  async function collectFiles(items: DataTransferItemList): Promise<File[]> {
    const files: File[] = [];
    const entries: FileSystemEntry[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const entry = item?.webkitGetAsEntry?.() ?? null;
      if (entry) entries.push(entry);
      else {
        const f = item?.getAsFile();
        if (f) files.push(f);
      }
    }
    async function walk(entry: FileSystemEntry): Promise<void> {
      if (entry.isFile) {
        const file = await new Promise<File | null>((resolve) =>
          (entry as FileSystemFileEntry).file(resolve, () => resolve(null)),
        );
        if (file) files.push(file);
        return;
      }
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const children = await new Promise<FileSystemEntry[]>((resolve) =>
        reader.readEntries((es) => resolve(es), () => resolve([])),
      );
      for (const child of children) await walk(child);
    }
    for (const entry of entries) await walk(entry);
    return files;
  }

  async function handleDrop(event: DragEvent<HTMLElement>): Promise<void> {
    event.preventDefault();
    setDragOver(false);
    setNotice(null);
    const files = await collectFiles(event.dataTransfer.items);
    await library.importFiles(files);
  }

  function requestRebind(): void {
    // 重新绑定走通用选择器：按“文件名+大小”匹配回原条目（library.importFiles）
    fileInputRef.current?.click();
  }

  async function handleImportJson(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      await library.importJson(await file.text());
      setNotice(null);
    } catch (err) {
      setNotice((err as Error).message);
    }
  }

  function handleExport(): void {
    const blob = new Blob([library.exportJson()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "listogether-playlist.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="card" data-testid="library-panel">
      <h2>房间曲库（房主）</h2>
      <p className="hint">本地文件在浏览器内解码，不上传；成员从曲库点歌，音频经 WebRTC 播放。{ACCEPTED_HINT}</p>

      <div
        className={`dropzone${dragOver ? " dragover" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        data-testid="library-dropzone"
      >
        拖放音频文件或文件夹到这里
        <div className="controls">
          <button type="button" onClick={() => fileInputRef.current?.click()} data-testid="library-file-btn">
            选择文件
          </button>
          <button type="button" onClick={() => folderInputRef.current?.click()} data-testid="library-folder-btn">
            选择文件夹
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            void library.importFiles(files);
          }}
        />
        <input
          ref={folderInputRef}
          type="file"
          hidden
          multiple
          // @ts-expect-error 非标准属性（Chrome/Edge/Firefox 支持）
          webkitdirectory="true"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            void library.importFiles(files);
          }}
        />
      </div>

      {library.importing && (
        <p className="hint" data-testid="library-importing">
          正在导入音频…
        </p>
      )}
      {library.importErrors.length > 0 && (
        <div role="alert" className="banner warn" data-testid="library-import-errors">
          <p>以下文件无法导入：</p>
          <ul>
            {library.importErrors.map((msg, i) => (
              <li key={i}>{msg}</li>
            ))}
          </ul>
          <button type="button" onClick={library.clearImportErrors}>
            知道了
          </button>
        </div>
      )}
      {notice && (
        <p role="alert" className="banner warn" data-testid="library-notice">
          {notice}
        </p>
      )}

      <div className="controls" data-testid="library-io">
        <button type="button" onClick={handleExport} data-testid="library-export-btn">
          导出歌单
        </button>
        <button type="button" onClick={() => importJsonInputRef.current?.click()} data-testid="library-import-btn">
          导入歌单
        </button>
        <input ref={importJsonInputRef} type="file" accept="application/json,.json" hidden onChange={handleImportJson} />
      </div>

      {library.entries.length === 0 ? (
        <p className="hint" data-testid="library-empty">
          曲库为空。导入本地音频后，成员即可点歌。
        </p>
      ) : (
        <ul data-testid="library-list">
          {library.entries.map((entry) => (
            <li key={entry.trackId} data-testid="library-item">
              {entry.coverUrl && <img src={entry.coverUrl} alt="" className="cover-thumb" width={36} height={36} />}
              <span className="queue-title">
                {entry.source && <span className="badge" data-testid="library-source-badge">{PLATFORM_BADGE[entry.source.platform] ?? entry.source.platform}</span>}{" "}
                《{entry.title}》{entry.artist ? ` — ${entry.artist}` : ""}
              </span>
              <span className="hint">
                {" "}
                · {formatMs(entry.durationMs)}
                {entry.file ? "" : entry.source ? " · 平台曲目（需绑定本机文件才能播放）" : " · 未加载（需重新选择文件）"}
                {entry.source?.playability && describePlayability(entry.source.playability)
                  ? ` · ${describePlayability(entry.source.playability)?.label}`
                  : ""}
                {library.hasLyrics(entry.trackId) ? " · 已有歌词" : ""}
              </span>
              <span className="member-admin">
                <button
                  type="button"
                  onClick={() => store.requestTrack(entry.trackId)}
                  data-testid="library-request-btn"
                >
                  加入队列
                </button>
                <button
                  type="button"
                  onClick={() => store.prepareNext({ trackId: entry.trackId, title: entry.title, durationMs: entry.durationMs })}
                  disabled={!entry.file}
                  title={entry.file ? "立即发起下一首屏障" : entry.source ? "平台曲目需本机对应文件" : "需要先加载本地文件"}
                  data-testid="library-play-btn"
                >
                  下一首播放
                </button>
                {!entry.file && !entry.source && (
                  <button type="button" onClick={requestRebind} data-testid="library-reload-btn">
                    重新加载
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setLyricsTarget(entry.trackId);
                    lyricsInputRef.current?.click();
                  }}
                  data-testid="library-lyrics-btn"
                >
                  {library.hasLyrics(entry.trackId) ? "更换歌词" : "指定歌词"}
                </button>
                <button type="button" onClick={() => library.removeEntry(entry.trackId)} data-testid="library-remove-btn">
                  移除
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <input ref={importJsonInputRef} type="file" accept="application/json,.json" hidden onChange={handleImportJson} />
      <input ref={lyricsInputRef} type="file" accept=".lrc,.txt,text/plain" hidden onChange={(e) => void handleLyricsFile(e)} />
    </section>
  );
}

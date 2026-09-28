/** useHostLibrary：房主本机曲库状态与导入编排（Phase 3/4，D-012/D-014/D-016/D-017）。
 * 房主浏览器内的文件注册表：trackId → File；成员点歌后屏障按 trackId 在此解析文件。
 * 仅元数据经 LIBRARY_ADD 进房间；音频文件永远不上传。
 * 歌词（D-017）：导入时自动匹配同名 .lrc/.txt，也可手动指定；发布经 TRACK_LYRICS。
 * 封面（D-016）：保留 ID3 封面字节供 DataChannel 发送。 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Track } from "@listogether/protocol";
import { decodeAudioFile } from "../../media/local-source/buffer-source";
import type { RoomStore } from "../../transport/ws/room-store";
import {
  entryBindingKey,
  exportLibrary,
  fileBindingKey,
  fileTitle,
  importEntriesToHost,
  loadLibrary,
  loadLyricsCache,
  makeTrackId,
  parseLibraryImport,
  readAudioTags,
  saveLibrary,
  saveLyricsCache,
  type HostLibraryEntry,
  type LibraryExport,
  type StoredLyrics,
} from "./library";
import {
  lyricsBindingKey,
  lyricsFormatForFileName,
  looksLikeLyricsFile,
  validateLyricsSize,
  LyricsTooLargeError,
} from "./lyrics";

export interface ImportedTrackInfo {
  trackId: string;
  title: string;
  durationMs: number;
}

export interface CoverBytes {
  bytes: Uint8Array;
  mime: string;
}

export interface HostLibraryApi {
  entries: HostLibraryEntry[];
  importing: boolean;
  importErrors: string[];
  clearImportErrors(): void;
  /** 导入文件；返回成功导入/绑定的条目信息（DEV 钩子与提示用）。 */
  importFiles(files: File[]): Promise<ImportedTrackInfo[]>;
  removeEntry(trackId: string): void;
  exportJson(): string;
  importJson(text: string): Promise<void>;
  /** 平台链接识别结果加入曲库（D-014，元数据条目，本机无文件）。 */
  addPlatformTrack(track: Track): void;
  /** 手动为条目指定歌词文件（D-017）；发布失败返回错误消息。 */
  attachLyrics(trackId: string, file: File): Promise<void>;
  /** 读取条目封面字节（DataChannel 发送用；无封面返回 null）。 */
  getCoverBytes(trackId: string): Promise<CoverBytes | null>;
  /** 本机是否缓存了该曲目歌词。 */
  hasLyrics(trackId: string): boolean;
  /** 有本地缓存歌词时（重新）发布；无缓存为 no-op（切歌补发用，D-017）。 */
  republishLyrics(trackId: string): void;
  /** 当前导入状态摘要（调试/证据用）。 */
  debug(): { count: number; loaded: number; importing: boolean };
}

export function useHostLibrary(store: RoomStore, enabled: boolean): HostLibraryApi {
  const [entries, setEntries] = useState<HostLibraryEntry[]>(() => loadLibrary(globalThis.localStorage ?? null));
  const [importing, setImporting] = useState(false);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const decodeCtxRef = useRef<AudioContext | null>(null);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  // 歌词缓存（trackId → 文本）：发布与重复发布去重都用它
  const lyricsRef = useRef<Map<string, StoredLyrics> | null>(null);
  function lyricsMap(): Map<string, StoredLyrics> {
    if (!lyricsRef.current) lyricsRef.current = loadLyricsCache(globalThis.localStorage ?? null);
    return lyricsRef.current;
  }
  // 同步维护的已知 trackId 集合：异步导入循环中 entriesRef 可能滞后，用它防重复导入
  const knownIdsRef = useRef<Set<string>>(new Set(entries.map((e) => e.trackId)));
  if (knownIdsRef.current.size === 0) {
    for (const e of entries) knownIdsRef.current.add(e.trackId);
  }

  // 曲库元数据持久化（仅房主本机）
  useEffect(() => {
    if (!enabled) return;
    saveLibrary(globalThis.localStorage ?? null, entries);
  }, [entries, enabled]);

  const getDecodeCtx = useCallback((): AudioContext => {
    if (!decodeCtxRef.current || decodeCtxRef.current.state === "closed") {
      decodeCtxRef.current = new AudioContext();
    }
    return decodeCtxRef.current;
  }, []);

  /** 发布歌词到房间（校验尺寸 → store 发布）；超限入 importErrors。 */
  const publishLyrics = useCallback(
    (trackId: string, cached: StoredLyrics): void => {
      try {
        validateLyricsSize(cached.text);
        store.publishLyrics(trackId, cached.format, cached.text);
      } catch (err) {
        if (err instanceof LyricsTooLargeError) {
          setImportErrors((prev) => [...prev, trackId + "：" + err.message].slice(-20));
        }
      }
    },
    [store],
  );

  const importFiles = useCallback(
    async (files: File[]): Promise<ImportedTrackInfo[]> => {
      if (files.length === 0) return [];
      setImporting(true);
      const imported: ImportedTrackInfo[] = [];
      const errors: string[] = [];
      const audioFiles = files.filter((f) => f.size > 0 && !looksLikeLyricsFile(f.name));
      // 同名歌词自动检测（D-017）：音频 basename → 歌词文件
      const lyricsByName = new Map<string, File>();
      for (const f of files) {
        if (looksLikeLyricsFile(f.name) && f.size <= 1024 * 1024) {
          lyricsByName.set(lyricsBindingKey(f.name), f);
        }
      }
      for (const file of audioFiles) {
        try {
          const bindingKey = fileBindingKey(file);
          const bindTarget = entriesRef.current.find((e) => entryBindingKey(e) === bindingKey);
          const tags = await readAudioTags(file);
          const lyricFile = lyricsByName.get(lyricsBindingKey(file.name));
          const lyricCache: StoredLyrics | null = lyricFile
            ? { format: lyricsFormatForFileName(lyricFile.name), text: await lyricFile.text() }
            : null;
          if (bindTarget && !bindTarget.file) {
            // 重新绑定：保留 trackId（已有队列请求不失效），刷新元数据
            const { buffer } = await decodeAudioFile(file, getDecodeCtx());
            if (bindTarget.coverUrl) URL.revokeObjectURL(bindTarget.coverUrl);
            const coverUrl = tags.coverBlob ? URL.createObjectURL(tags.coverBlob) : null;
            setEntries((prev) =>
              prev.map((e) =>
                e.trackId === bindTarget.trackId
                  ? {
                      ...e,
                      file,
                      storedFile: null,
                      coverUrl,
                      coverBlob: tags.coverBlob ?? null,
                      title: tags.title || e.title,
                      artist: tags.artist ?? e.artist,
                      durationMs: Math.round(buffer.duration * 1000),
                    }
                  : e,
              ),
            );
            if (lyricCache) {
              lyricsMap().set(bindTarget.trackId, lyricCache);
              saveLyricsCache(globalThis.localStorage ?? null, lyricsMap());
              publishLyrics(bindTarget.trackId, lyricCache);
            }
            imported.push({ trackId: bindTarget.trackId, title: tags.title || bindTarget.title, durationMs: Math.round(buffer.duration * 1000) });
            continue;
          }
          const trackId = makeTrackId(file);
          if (knownIdsRef.current.has(trackId)) {
            // 同一文件重复导入：仅补齐文件绑定
            setEntries((prev) => prev.map((e) => (e.trackId === trackId && !e.file ? { ...e, file, storedFile: null } : e)));
            const existing = entriesRef.current.find((e) => e.trackId === trackId);
            if (existing) imported.push({ trackId, title: existing.title, durationMs: existing.durationMs });
            if (lyricCache) {
              lyricsMap().set(trackId, lyricCache);
              saveLyricsCache(globalThis.localStorage ?? null, lyricsMap());
              publishLyrics(trackId, lyricCache);
            }
            continue;
          }
          knownIdsRef.current.add(trackId);
          const { buffer } = await decodeAudioFile(file, getDecodeCtx());
          const coverUrl = tags.coverBlob ? URL.createObjectURL(tags.coverBlob) : null;
          const entry: HostLibraryEntry = {
            trackId,
            title: tags.title || fileTitle(file.name),
            artist: tags.artist ?? "",
            durationMs: Math.round(buffer.duration * 1000),
            addedAtMs: Date.now(),
            file,
            storedFile: null,
            coverUrl,
            coverBlob: tags.coverBlob ?? null,
            source: null,
          };
          setEntries((prev) => [...prev, entry]);
          imported.push({ trackId, title: entry.title, durationMs: entry.durationMs });
          if (lyricCache) {
            lyricsMap().set(trackId, lyricCache);
            saveLyricsCache(globalThis.localStorage ?? null, lyricsMap());
            publishLyrics(trackId, lyricCache);
          }
        } catch {
          errors.push(file.name + "：浏览器不支持该格式或文件已损坏");
        }
      }
      if (errors.length > 0) setImportErrors((prev) => [...prev, ...errors].slice(-20));
      setImporting(false);
      return imported;
    },
    [getDecodeCtx, publishLyrics],
  );

  // 曲库元数据上报（仅房主）：订阅快照变化，凡服务端曲库缺失的条目持续补报，
  // 直到 LIBRARY_ADD 生效（连接未就绪时的首次发送失败也由此兜底）。服务端按 trackId 幂等去重。
  useEffect(() => {
    if (!enabled || importing) return;
    const push = () => {
      const room = store.getState().room;
      if (!room) return;
      const missing = entriesRef.current.filter((e) => !room.library?.some((l) => l.trackId === e.trackId));
      if (missing.length === 0) return;
      store.libraryAdd(
        missing.map((e) => ({
          trackId: e.trackId,
          title: e.title,
          artist: e.artist || undefined,
          durationMs: e.durationMs,
          source: e.source ?? undefined,
        })),
      );
    };
    push();
    return store.subscribe(push);
  }, [entries, importing, enabled, store]);

  const removeEntry = useCallback(
    (trackId: string) => {
      knownIdsRef.current.delete(trackId);
      lyricsMap().delete(trackId);
      saveLyricsCache(globalThis.localStorage ?? null, lyricsMap());
      setEntries((prev) => {
        const target = prev.find((e) => e.trackId === trackId);
        if (target?.coverUrl) URL.revokeObjectURL(target.coverUrl);
        return prev.filter((e) => e.trackId !== trackId);
      });
      store.libraryRemove(trackId);
    },
    [store],
  );

  const exportJson = useCallback(() => JSON.stringify(exportLibrary(entriesRef.current), null, 2), []);

  const importJson = useCallback(async (text: string) => {
    let data: LibraryExport;
    try {
      data = parseLibraryImport(text);
    } catch (err) {
      setImportErrors((prev) => [...prev, (err as Error).message].slice(-20));
      return;
    }
    const imported = importEntriesToHost(data);
    setEntries((prev) => {
      const known = new Set(prev.map((e) => e.trackId));
      return [...prev, ...imported.filter((e) => !known.has(e.trackId))];
    });
  }, []);

  /** 平台链接识别结果入曲库（D-014）：元数据条目，本机无音频文件。 */
  const addPlatformTrack = useCallback(
    (track: Track) => {
      if (knownIdsRef.current.has(track.trackId)) {
        setEntries((prev) =>
          prev.map((e) =>
            e.trackId === track.trackId && e.source == null && track.source ? { ...e, source: track.source } : e,
          ),
        );
        return;
      }
      knownIdsRef.current.add(track.trackId);
      setEntries((prev) => [
        ...prev,
        {
          trackId: track.trackId,
          title: track.title,
          artist: track.artist ?? "",
          durationMs: track.durationMs,
          addedAtMs: Date.now(),
          file: null,
          storedFile: null,
          coverUrl: null,
          coverBlob: null,
          source: track.source ?? null,
        },
      ]);
    },
    [],
  );

  /** 手动指定歌词文件（D-017）：读取 → 校验 → 缓存 → 发布。 */
  const attachLyrics = useCallback(
    async (trackId: string, file: File) => {
      const cached: StoredLyrics = { format: lyricsFormatForFileName(file.name), text: await file.text() };
      validateLyricsSize(cached.text); // 超限直接抛给 UI
      lyricsMap().set(trackId, cached);
      saveLyricsCache(globalThis.localStorage ?? null, lyricsMap());
      publishLyrics(trackId, cached);
    },
    [publishLyrics],
  );

  /** 封面字节（D-016）：ID3 APIC 原始字节；无封面/未加载返回 null。 */
  const getCoverBytes = useCallback(async (trackId: string): Promise<CoverBytes | null> => {
    const entry = entriesRef.current.find((e) => e.trackId === trackId);
    if (!entry?.coverBlob) return null;
    const bytes = new Uint8Array(await entry.coverBlob.arrayBuffer());
    return { bytes, mime: entry.coverBlob.type || "image/jpeg" };
  }, []);

  const hasLyrics = useCallback((trackId: string) => lyricsMap().has(trackId), []);

  const republishLyrics = useCallback(
    (trackId: string) => {
      const cached = lyricsMap().get(trackId);
      if (cached) publishLyrics(trackId, cached);
    },
    [publishLyrics],
  );

  const clearImportErrors = useCallback(() => setImportErrors([]), []);

  const debug = useCallback(
    () => ({ count: entriesRef.current.length, loaded: entriesRef.current.filter((e) => e.file).length, importing }),
    [importing],
  );

  return {
    entries,
    importing,
    importErrors,
    clearImportErrors,
    importFiles,
    removeEntry,
    exportJson,
    importJson,
    addPlatformTrack,
    attachLyrics,
    getCoverBytes,
    hasLyrics,
    republishLyrics,
    debug,
  };
}

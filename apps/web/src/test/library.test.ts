/** 曲库纯函数测试（Phase 3）：trackId 稳定性、ID3v2 解析、持久化与导入导出。 */
import { describe, expect, it } from "vitest";
import {
  exportLibrary,
  fileBindingKey,
  fileTitle,
  fnv1aHex,
  importEntriesToHost,
  loadLibrary,
  makeTrackId,
  parseId3Tags,
  parseLibraryImport,
  saveLibrary,
  toStoredEntries,
  type HostLibraryEntry,
} from "../features/room/library";

// ---- 合成 ID3v2.3 数据 ----

function frame(id: string, payload: number[]): number[] {
  const size = payload.length;
  return [
    ...[...id].map((c) => c.charCodeAt(0)),
    (size >>> 24) & 0xff,
    (size >>> 16) & 0xff,
    (size >>> 8) & 0xff,
    size & 0xff,
    0x00,
    0x00,
    ...payload,
  ];
}

function synchsafe(size: number): number[] {
  return [(size >>> 21) & 0x7f, (size >>> 14) & 0x7f, (size >>> 7) & 0x7f, size & 0x7f];
}

function id3Buffer(frames: number[][]): ArrayBuffer {
  const body = frames.flat();
  const bytes = [
    0x49, 0x44, 0x33, // "ID3"
    0x03, 0x00, // v2.3
    0x00, // flags
    ...synchsafe(body.length),
    ...body,
  ];
  return new Uint8Array(bytes).buffer;
}

const utf8 = (s: string): number[] => [...new TextEncoder().encode(s)];

function makeEntry(overrides: Partial<HostLibraryEntry> = {}): HostLibraryEntry {
  return {
    trackId: "local-aa",
    title: "Song",
    artist: "",
    durationMs: 1000,
    addedAtMs: 1,
    file: null,
    storedFile: null,
    coverUrl: null,
    ...overrides,
  };
}

describe("trackId 与绑定键", () => {
  it("同一文件元数据生成稳定 trackId；不同文件不同", () => {
    const a = { name: "song.mp3", size: 123, lastModified: 456 };
    const b = { name: "song.mp3", size: 124, lastModified: 456 };
    expect(makeTrackId(a)).toBe(makeTrackId({ ...a }));
    expect(makeTrackId(a)).not.toBe(makeTrackId(b));
    expect(makeTrackId(a)).toMatch(/^local-[0-9a-f]{8}$/);
    expect(fnv1aHex("")).toBe("811c9dc5");
  });

  it("fileBindingKey 按名称+大小匹配；fileTitle 去扩展名", () => {
    expect(fileBindingKey({ name: "a.mp3", size: 1 })).toBe(fileBindingKey({ name: "a.mp3", size: 1 }));
    expect(fileBindingKey({ name: "a.mp3", size: 2 })).not.toBe(fileBindingKey({ name: "a.mp3", size: 1 }));
    expect(fileTitle("我的 歌.v2.mp3")).toBe("我的 歌.v2");
    expect(fileTitle(".mp3")).toBe("本地音频");
  });
});

describe("parseId3Tags", () => {
  it("解析 TIT2/TPE1/APIC（v2.3）", () => {
    const cover = [0x89, 0x50, 0x4e, 0x47];
    const apic = [0x00, ...utf8("image/png"), 0x00, 0x03, 0x00, ...cover];
    const tags = parseId3Tags(
      id3Buffer([
        frame("TIT2", [0x03, ...utf8("测试标题")]),
        frame("TPE1", [0x03, ...utf8("测试艺人")]),
        frame("APIC", apic),
      ]),
    );
    expect(tags.title).toBe("测试标题");
    expect(tags.artist).toBe("测试艺人");
    expect(tags.coverBlob).toBeInstanceOf(Blob);
    expect(tags.coverBlob?.type).toBe("image/png");
  });

  it("非 ID3 / 损坏数据返回空对象", () => {
    expect(parseId3Tags(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer)).toEqual({});
    expect(parseId3Tags(new ArrayBuffer(0))).toEqual({});
    // ID3 头但版本不支持（v2.2）
    const v22 = new Uint8Array([0x49, 0x44, 0x33, 0x02, 0x00, 0x00, 0, 0, 0, 0]);
    expect(parseId3Tags(v22.buffer)).toEqual({});
  });
});

describe("持久化与导入导出", () => {
  it("save/load 往返保留元数据与绑定信息（不含文件字节）", () => {
    const store = new Map<string, string>();
    const fakeStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    } as Storage;
    const entries = [
      makeEntry({ file: new File([], "a.mp3"), title: "A" }),
      makeEntry({ trackId: "local-bb", storedFile: { name: "b.mp3", size: 5 } }),
    ];
    saveLibrary(fakeStorage, entries);
    const loaded = loadLibrary(fakeStorage);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]?.title).toBe("A");
    expect(loaded[0]?.file).toBeNull();
    expect(loaded[1]?.storedFile).toEqual({ name: "b.mp3", size: 5 });
  });

  it("损坏的持久化数据返回空", () => {
    const fakeStorage = {
      getItem: () => "{not-json",
      setItem: () => undefined,
      removeItem: () => undefined,
    } as unknown as Storage;
    expect(loadLibrary(fakeStorage)).toEqual([]);
    expect(loadLibrary(null)).toEqual([]);
  });

  it("导出/导入最小格式；非法导入报可读错误", () => {
    const entries = [makeEntry({ file: new File([], "a.mp3") })];
    const json = JSON.stringify(exportLibrary(entries));
    expect(JSON.parse(json).version).toBe(1);

    const parsed = parseLibraryImport(json);
    expect(importEntriesToHost(parsed)[0]?.trackId).toBe("local-aa");
    expect(() => parseLibraryImport("nope")).toThrow("JSON");
    expect(() => parseLibraryImport(JSON.stringify({ version: 99, tracks: [] }))).toThrow("version");
    expect(() => parseLibraryImport(JSON.stringify({ version: 1, tracks: [{ title: "x" }] }))).toThrow("trackId");
  });

  it("toStoredEntries 使用 storedFile 兜底", () => {
    const stored = toStoredEntries([makeEntry({ storedFile: { name: "c.mp3", size: 9 } })]);
    expect(stored[0]?.file).toEqual({ name: "c.mp3", size: 9 });
  });

  it("saveLibrary 在存储不可用时静默跳过", () => {
    expect(() => saveLibrary(null, [])).not.toThrow();
    const bad = { setItem: () => { throw new Error("quota"); }, getItem: () => null, removeItem: () => undefined } as unknown as Storage;
    expect(() => saveLibrary(bad, [makeEntry()])).not.toThrow();
  });
});

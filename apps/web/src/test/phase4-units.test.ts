/** Phase 4 功能单测：歌词解析、封面分块/缓存、平台链接规范化、Media Session。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  currentLyricsLineIndex,
  looksLikeLyricsFile,
  lyricsBindingKey,
  lyricsFormatForFileName,
  parseLrc,
  parseLyrics,
  validateLyricsSize,
  LyricsTooLargeError,
} from "../features/room/lyrics";
import {
  base64ToBytes,
  bytesToBase64,
  chunkCover,
  CoverAssembler,
  CoverStore,
  pickJpegQuality,
} from "../media/cover-channel";
import { LinkFormatError, describePlayability, normalizeLink } from "../features/providers/normalize";
import { sourceExternalTrackId } from "../features/providers/LinkResolver";
import { MediaSessionController } from "../media/media-session";
import { getWakeLockApi } from "../media/wake-lock";
import { stripId3v2 } from "../media/local-source/buffer-source";

// ---- ID3v2 剥离（E2E 发现：Chrome decodeAudioData 不接受 ID3 前缀的 WAV） ----

describe("stripId3v2", () => {
  // 构造：10 字节头（size 域 = 标签帧长度，不含头自身）+ 标签帧 + 音频数据
  function withId3Tag(frames: Uint8Array, audio: Uint8Array, footerBits = false): ArrayBuffer {
    const header = new Uint8Array(10);
    header[0] = 0x49; // I
    header[1] = 0x44; // D
    header[2] = 0x33; // 3
    header[3] = 0x03; // v2.3
    if (footerBits) header[5] = 0x10;
    const size = frames.length;
    header[6] = (size >> 21) & 0x7f;
    header[7] = (size >> 14) & 0x7f;
    header[8] = (size >> 7) & 0x7f;
    header[9] = size & 0x7f;
    const footer = footerBits ? new Uint8Array(10) : new Uint8Array(0);
    const out = new Uint8Array(10 + frames.length + footer.length + audio.length);
    out.set(header, 0);
    out.set(frames, 10);
    out.set(footer, 10 + frames.length);
    out.set(audio, 10 + frames.length + footer.length);
    return out.buffer;
  }

  it("剥离 ID3v2 前缀返回剩余字节", () => {
    const audio = new Uint8Array([1, 2, 3, 4]);
    const stripped = new Uint8Array(stripId3v2(withId3Tag(new Uint8Array(4), audio)));
    expect([...stripped]).toEqual([1, 2, 3, 4]);
  });

  it("无 ID3 头时原样返回", () => {
    const raw = new Uint8Array([9, 8, 7]).buffer;
    expect(stripId3v2(raw)).toBe(raw);
  });

  it("tag 大小越界时原样返回（防损坏文件截断）", () => {
    const header = new Uint8Array(10);
    header[0] = 0x49;
    header[1] = 0x44;
    header[2] = 0x33;
    header[3] = 0x03;
    header[6] = 0x7f; // 巨大的 synchsafe 大小
    header[7] = 0x7f;
    header[8] = 0x7f;
    header[9] = 0x7f;
    expect(stripId3v2(header.buffer)).toBe(header.buffer);
  });

  it("footer 位时额外跳过 10 字节", () => {
    const audio = new Uint8Array([5, 6]);
    expect([...new Uint8Array(stripId3v2(withId3Tag(new Uint8Array(4), audio, true)))]).toEqual([5, 6]);
  });
});

// ---- 歌词（D-017） ----

describe("LRC 歌词解析", () => {
  it("解析逐行时间戳并排序", () => {
    const lrc = "[00:18.50]第二句\n[00:12.00]第一句\n[01:02.3]第三句";
    const lines = parseLrc(lrc);
    expect(lines.map((l) => l.text)).toEqual(["第一句", "第二句", "第三句"]);
    expect(lines[0]?.timeMs).toBe(12000);
    expect(lines[1]?.timeMs).toBe(18500);
    expect(lines[2]?.timeMs).toBe(62300); // 2 位小数按百分秒
  });

  it("一行多时间戳与元数据标签", () => {
    const lrc = "[ti:测试]\n[00:01.00][00:05.00]重复行\n[ar:歌手]";
    const lines = parseLrc(lrc);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.timeMs).toBe(1000);
    expect(lines[1]?.timeMs).toBe(5000);
    expect(lines[0]?.text).toBe("重复行");
  });

  it("3 位毫秒时间戳", () => {
    expect(parseLrc("[00:01.250]x")[0]?.timeMs).toBe(1250);
  });

  it("纯文本格式按行展示", () => {
    const parsed = parseLyrics("第一行\n\n第二行", "plain");
    expect(parsed.format).toBe("plain");
    expect(parsed.lines.map((l) => l.text)).toEqual(["第一行", "第二行"]);
  });

  it("lrc 无有效时间戳时降级为纯文本", () => {
    const parsed = parseLyrics("没有时间戳", "lrc");
    expect(parsed.format).toBe("plain");
    expect(parsed.lines).toHaveLength(1);
  });

  it("当前行二分定位", () => {
    const lines = parseLrc("[00:10.00]a\n[00:20.00]b\n[00:30.00]c");
    expect(currentLyricsLineIndex(lines, 5000)).toBe(-1);
    expect(currentLyricsLineIndex(lines, 10000)).toBe(0);
    expect(currentLyricsLineIndex(lines, 21500)).toBe(1);
    expect(currentLyricsLineIndex(lines, 99999)).toBe(2);
  });

  it("文件名与绑定键", () => {
    expect(lyricsFormatForFileName("song.lrc")).toBe("lrc");
    expect(lyricsFormatForFileName("song.txt")).toBe("plain");
    expect(looksLikeLyricsFile("a.LRC")).toBe(true);
    expect(looksLikeLyricsFile("a.mp3")).toBe(false);
    expect(lyricsBindingKey("我的 歌.Song .lrc")).toBe(lyricsBindingKey("我的歌.Song.mp3"));
  });

  it("尺寸校验：48KB/500 行/单行 512 字节", () => {
    expect(() => validateLyricsSize("short")).not.toThrow();
    expect(() => validateLyricsSize("x".repeat(48 * 1024 + 1))).toThrow(LyricsTooLargeError);
    expect(() => validateLyricsSize(Array.from({ length: 501 }, () => "x").join("\n"))).toThrow(LyricsTooLargeError);
    expect(() => validateLyricsSize("中".repeat(257))).toThrow(LyricsTooLargeError); // 257×3B=771
    expect(() => validateLyricsSize("中".repeat(170))).not.toThrow();
  });
});

// ---- 封面 DataChannel（D-016） ----

describe("封面分块与重组", () => {
  it("base64 往返", () => {
    const bytes = new Uint8Array(1000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("分块→组装往返（多块）", () => {
    const bytes = new Uint8Array(120_000).fill(7);
    const packed = chunkCover("t1", "image/jpeg", bytes);
    expect(packed).not.toBeNull();
    let received: { trackId: string; mime: string; bytes: Uint8Array } | null = null;
    const assembler = new CoverAssembler((trackId, mime, out) => {
      received = { trackId, mime, bytes: out };
    });
    expect(assembler.handle(packed!.meta)).toBe(true);
    for (const chunk of packed!.chunks) expect(assembler.handle(chunk)).toBe(true);
    expect(received!.trackId).toBe("t1");
    expect(received!.mime).toBe("image/jpeg");
    expect(received!.bytes).toEqual(bytes);
  });

  it("乱序接收也能组装", () => {
    const bytes = new Uint8Array(60_000).fill(3);
    const packed = chunkCover("t2", "image/png", bytes);
    const assembler = new CoverAssembler(() => {});
    const reversed = [...packed!.chunks].reverse();
    for (const chunk of reversed) assembler.handle(chunk);
    // 只有 meta 在收齐后才触发回调，这里先发 chunk 也应可乱序缓存
    expect(assembler.handle(packed!.meta)).toBe(true);
  });

  it("超过 512KB 的 meta 被拒绝", () => {
    const assembler = new CoverAssembler(() => {});
    expect(assembler.handle({ kind: "cover-meta", trackId: "t", mime: "i", totalChunks: 1, size: 600_000 })).toBe(false);
    expect(assembler.handle({ kind: "cover-meta", trackId: "t", mime: "i", totalChunks: 0, size: 1 })).toBe(false);
  });

  it("质量阶梯选择", () => {
    expect(pickJpegQuality([0.85, 0.7, 0.5], (q) => q * 100_000, 80_000)).toBe(0.7);
    expect(pickJpegQuality([0.85], () => 90_000, 80_000)).toBeNull();
  });

  it("CoverStore LRU 与订阅", () => {
    // node 环境没有 objectURL：用可回收桩
    const created: string[] = [];
    vi.stubGlobal("URL", {
      ...globalThis.URL,
      createObjectURL: () => "blob:fake-" + created.length,
      revokeObjectURL: () => {},
    });
    const store = new CoverStore(2);
    let notified = 0;
    store.subscribe(() => notified++);
    store.put("t1", "image/jpeg", new Uint8Array([1]));
    store.put("t2", "image/jpeg", new Uint8Array([2]));
    expect(store.get("t1")?.url).toBeTruthy();
    store.put("t3", "image/jpeg", new Uint8Array([3])); // 淘汰 t1
    expect(store.get("t1")).toBeNull();
    expect(store.get("t3")?.url).toBeTruthy();
    expect(notified).toBe(3);
    store.dispose();
    vi.unstubAllGlobals();
  });
});

// ---- 平台链接规范化（D-014，与 Go providers_test 同矩阵） ----

describe("平台链接规范化", () => {
  const ok: Array<[string, string, string]> = [
    ["https://music.163.com/song?id=347230&userid=1", "netease", "https://music.163.com/song?id=347230"],
    ["https://music.163.com/song/347230/?from=search", "netease", "https://music.163.com/song?id=347230"],
    ["https://y.qq.com/n/yqq/song/0039MnYb0qxYhV.html?stat=y", "qqmusic", "https://y.qq.com/n/yqq/song/0039MnYb0qxYhV.html"],
    ["https://i.y.qq.com/n2/m/share/details/mb.html?songmid=0039MnYb0qxYhV", "qqmusic", "https://y.qq.com/n/yqq/song/0039MnYb0qxYhV.html"],
    ["https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=abc", "spotify", "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"],
    ["https://open.spotify.com/intl-zh-CN/track/4cOdK2wGLETKBW3PvgPWqT", "spotify", "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"],
    ["https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT", "spotify", "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"],
    ["https://music.youtube.com/watch?v=dQw4w9WgXcQ&si=x", "ytmusic", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?si=abc", "ytmusic", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
  ];
  for (const [raw, platform, normalized] of ok) {
    it("规范化 " + raw, () => {
      const result = normalizeLink(raw);
      expect(result.platform).toBe(platform);
      expect(result.normalizedUrl).toBe(normalized);
    });
  }

  const rejected: Array<[string, "unsupported" | "invalid"]> = [
    ["https://example.com/song?id=1", "unsupported"],
    ["https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy", "invalid"],
    ["https://music.163.com/song?id=abc", "invalid"],
    ["https://music.163.com/song", "invalid"],
    ["ftp://music.163.com/song?id=1", "invalid"],
    ["", "invalid"],
    ["://broken", "invalid"],
  ];
  for (const [raw, reason] of rejected) {
    it("拒绝 " + raw, () => {
      expect(() => normalizeLink(raw)).toThrow(LinkFormatError);
      try {
        normalizeLink(raw);
      } catch (err) {
        expect((err as LinkFormatError).reason).toBe(reason);
      }
    });
  }

  it("播放能力说明与来源 trackId 稳定性", () => {
    expect(describePlayability("playable")?.tone).toBe("ok");
    expect(describePlayability("needs_login")?.tone).toBe("warn");
    expect(describePlayability(undefined)).toBeNull();
    const source = { platform: "netease" as const, url: "https://music.163.com/song?id=347230", externalId: "347230" };
    expect(sourceExternalTrackId(source)).toBe(sourceExternalTrackId({ ...source }));
    expect(sourceExternalTrackId(source)).toMatch(/^ext-netease-[0-9a-f]{8}$/);
  });
});

// ---- Media Session 与 Wake Lock（Phase 4） ----

describe("MediaSessionController", () => {
  class FakeMetadata {
    title = "";
    artist = "";
    album = "";
  }
  function fakeSession() {
    const handlers = new Map<string, ((d?: unknown) => void) | null>();
    return {
      metadata: null as unknown,
      playbackState: "none",
      positionState: null as unknown,
      setActionHandler: (action: string, handler: ((d?: unknown) => void) | null) => {
        handlers.set(action, handler);
      },
      handlers,
      MediaMetadataCtor: FakeMetadata,
    };
  }

  it("无 mediaSession 时全部安全降级", () => {
    const controller = new MediaSessionController({ session: null, onPlay: () => {}, onPause: () => {}, onSeekTo: () => {}, onSkipNext: () => {} });
    expect(() => controller.setMetadata({ title: "x" })).not.toThrow();
    expect(() => controller.setPlaybackState(true, 1, 100)).not.toThrow();
    controller.dispose();
  });

  it("注册动作回调并更新元数据/进度", () => {
    // node 环境没有 MediaMetadata：桩一个最小构造器
    vi.stubGlobal(
      "MediaMetadata",
      class {
        title: string;
        artist: string;
        album: string;
        constructor(init: { title: string; artist: string; album: string }) {
          this.title = init.title;
          this.artist = init.artist;
          this.album = init.album;
        }
      },
    );
    const s = fakeSession() as unknown as Navigator["mediaSession"] & Record<string, unknown>;
    let played = false;
    const controller = new MediaSessionController({
      session: s,
      onPlay: () => {
        played = true;
      },
      onPause: () => {},
      onSeekTo: () => {},
      onSkipNext: () => {},
    });
    controller.setPlaybackState(true, 500, 1000);
    expect(s.playbackState).toBe("playing");
    controller.setMetadata({ title: "歌", artist: "人" });
    expect((s.metadata as { title: string }).title).toBe("歌");
    const playHandler = (s.handlers as Map<string, () => void>).get("play");
    playHandler?.();
    expect(played).toBe(true);
    controller.dispose();
    vi.unstubAllGlobals();
  });

  it("wakeLock API 缺失返回 null", () => {
    expect(getWakeLockApi({} as Navigator)).toBeNull();
    expect(getWakeLockApi(null)).toBeNull();
  });
});

describe("RoomStore TRACK_LYRICS", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("收到 TRACK_LYRICS 进入状态并可发布（D-017）", async () => {
    const { RoomStore } = await import("../transport/ws/room-store");
    const { FakeWebSocket, stubWebSocket } = await import("./helpers");
    stubWebSocket();
    const store = new RoomStore({
      roomId: "room-1",
      sessionToken: "tok",
      memberId: "host-1",
      serverTimeMs: 1_000_000,
      localTimeMs: 1_000_000,
    });
    store.connect();
    const ws = FakeWebSocket.latest!;
    ws.simulateOpen();
    ws.simulateServerMessage({
      v: 1,
      type: "ROOM_SNAPSHOT",
      eventId: "e1",
      roomRevision: 1,
      senderId: "relay",
      sentAtMs: 0,
      payload: {
        roomId: "room-1",
        revision: 1,
        playing: false,
        positionMs: 0,
        currentTrack: { trackId: "t1", title: "A", durationMs: 1000 },
        transitionId: null,
        startAtMs: null,
        queue: [],
        members: [{ memberId: "host-1", name: "房主", role: "host", status: "online" }],
      },
    });
    ws.simulateServerMessage({
      v: 1,
      type: "TRACK_LYRICS",
      eventId: "e2",
      roomRevision: 1,
      senderId: "relay",
      sentAtMs: 0,
      payload: { trackId: "t1", format: "lrc", lyrics: "[00:01.00]hello" },
    });
    expect(store.getState().lyrics?.lyrics).toBe("[00:01.00]hello");

    // 房主发布：TRACK_LYRICS 帧出站
    expect(store.publishLyrics("t1", "plain", "第一行")).toBe(true);
    const sent = ws.sentTypes();
    expect(sent[sent.length - 1]).toBe("TRACK_LYRICS");
  });
});

describe("来源曲目降级文案", () => {
  it("describePlayability 覆盖全部枚举", () => {
    for (const p of ["playable", "needs_login", "preview_only", "region_locked", "unavailable", "unknown"]) {
      expect(describePlayability(p)).not.toBeNull();
    }
  });
});

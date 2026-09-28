/** Phase 4.5 收尾包单测：上一首选择器、带宽估算、致命断线重试、flac/m4a 标签解析。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previousTrackFromHistory } from "../features/queue/history";
import { estimateHostUpstreamKbps, estimateTrackKbps, HOST_UPSTREAM_WARN_KBPS } from "../features/room/bandwidth";
import { parseFlacTags, parseMp4Tags, readAudioTags } from "../features/room/library";
import type { HistoryEntry } from "@listogether/protocol";

// ---- 上一首选择器（D-020） ----

function hist(id: string, outcome: HistoryEntry["outcome"]): HistoryEntry {
  return { track: { trackId: id, title: "T-" + id, durationMs: 1000 }, outcome, atMs: 1 };
}

describe("previousTrackFromHistory", () => {
  it("空历史返回 null", () => {
    expect(previousTrackFromHistory([])).toBeNull();
  });

  it("取最近一条 played/skipped；failed/rejected 不回放", () => {
    const history = [hist("a", "failed"), hist("b", "played"), hist("c", "skipped")];
    expect(previousTrackFromHistory(history)?.trackId).toBe("b");
  });

  it("歌曲刚结束时 history[0] 是它自己：重播是预期语义", () => {
    expect(previousTrackFromHistory([hist("just-finished", "skipped")])?.trackId).toBe("just-finished");
  });

  it("保留 track 元数据（屏障需要 title/durationMs）", () => {
    const t = previousTrackFromHistory([hist("x", "played")]);
    expect(t?.title).toBe("T-x");
    expect(t?.durationMs).toBe(1000);
  });
});

// ---- 带宽估算（D-020） ----

describe("上行带宽估算", () => {
  it("码率 = 文件大小×8÷时长（5MB / 128s ≈ 328 kbps）", () => {
    const kbps = estimateTrackKbps(5 * 1024 * 1024, 128_000);
    expect(kbps).toBeGreaterThan(320);
    expect(kbps).toBeLessThan(335);
  });

  it("非法输入返回 null（不给误导数字）", () => {
    expect(estimateTrackKbps(0, 1000)).toBeNull();
    expect(estimateTrackKbps(100, 0)).toBeNull();
    expect(estimateTrackKbps(Number.NaN, 1000)).toBeNull();
  });

  it("总上行 = 码率 × 连接成员数；0 成员返回 null", () => {
    const file = { size: 1_000_000 };
    expect(estimateHostUpstreamKbps(file, 8_000, 4)).toBe(estimateTrackKbps(1_000_000, 8_000)! * 4);
    expect(estimateHostUpstreamKbps(file, 8_000, 0)).toBeNull();
    expect(estimateHostUpstreamKbps(null, 8_000, 4)).toBeNull();
  });

  it("警告阈值常量为 10 Mbps", () => {
    expect(HOST_UPSTREAM_WARN_KBPS).toBe(10_000);
  });
});

// ---- 致命断线重试（D-020） ----

describe("RoomStore 致命断线重试", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("10 次重连失败 → retry_exhausted；重试连接重置并重连", async () => {
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
    FakeWebSocket.latest!.simulateOpen();
    // 反复异常断线（每次等退避重连），第 10 次进入致命态
    for (let i = 0; i < 10; i++) {
      FakeWebSocket.latest!.simulateAbnormalClose();
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(store.getState().fatalKind).toBe("retry_exhausted");
    expect(store.getState().fatalMessage).toContain("多次重连失败");

    const countBefore = FakeWebSocket.instances.length;
    store.retryReconnect();
    expect(store.getState().fatalKind).toBeNull();
    expect(store.getState().status).toBe("connecting");
    expect(FakeWebSocket.instances.length).toBe(countBefore + 1);
    // 新连接可用
    FakeWebSocket.latest!.simulateOpen();
    expect(store.getState().status).toBe("connected");
  });

  it("非 retry 类致命不提供重试（retryReconnect 是 no-op）", async () => {
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
    FakeWebSocket.latest!.simulateOpen();
    FakeWebSocket.latest!.close(4001);
    expect(store.getState().fatalKind).toBe("session_invalid");
    store.retryReconnect();
    expect(store.getState().fatalKind).toBe("session_invalid");
    expect(store.getState().status).toBe("closed");
  });
});

// ---- flac / mp4 标签解析（D-020） ----

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function u32beBytes(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
}

function u32leBytes(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

function atom(type: string | Uint8Array, payload: Uint8Array): Uint8Array {
  // MP4 atom 类型是原始 4 字节：© = 0xA9（不能用 TextEncoder，会把 © 编成 2 字节 UTF-8）
  const typeBytes = typeof type === "string" ? bytes(type) : type;
  if (typeBytes.length !== 4) throw new Error("atom type 必须是 4 字节: " + type);
  return concatBytes(u32beBytes(8 + payload.length), typeBytes, payload);
}

const NAM = new Uint8Array([0xa9, 0x6e, 0x61, 0x6d]); // ©nam
const ART = new Uint8Array([0xa9, 0x41, 0x52, 0x54]); // ©ART

const FAKE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const FAKE_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

describe("FLAC 标签解析", () => {
  function flacFixture(): ArrayBuffer {
    // VORBIS_COMMENT：vendor + TITLE/ARTIST
    const comments = concatBytes(
      u32leBytes(4),
      bytes("test"),
      u32leBytes(2),
      u32leBytes(bytes("TITLE=无损测试曲").length),
      bytes("TITLE=无损测试曲"),
      u32leBytes(bytes("ARTIST=无损艺人").length),
      bytes("ARTIST=无损艺人"),
    );
    const vorbisBlock = concatBytes(new Uint8Array([0x04]), u32beBytes(comments.length).subarray(1), comments);
    // PICTURE：type=3（front cover）+ image/png + 空 desc + 尺寸 + 数据
    const picture = concatBytes(
      u32beBytes(3),
      u32beBytes(9),
      bytes("image/png"),
      u32beBytes(0),
      new Uint8Array(16),
      u32beBytes(FAKE_PNG.length),
      FAKE_PNG,
    );
    const pictureBlock = concatBytes(new Uint8Array([0x86]), u32beBytes(picture.length).subarray(1), picture);
    return concatBytes(bytes("fLaC"), vorbisBlock, pictureBlock).buffer as ArrayBuffer;
  }

  it("解析 TITLE/ARTIST 与 PICTURE 封面", async () => {
    const tags = await readAudioTags(new File([flacFixture()], "song.flac"));
    expect(tags.title).toBe("无损测试曲");
    expect(tags.artist).toBe("无损艺人");
    expect(tags.coverBlob?.type).toBe("image/png");
    expect(tags.coverBlob?.size).toBe(FAKE_PNG.length);
  });

  it("非 FLAC 魔数返回空对象", () => {
    expect(parseFlacTags(new Uint8Array([1, 2, 3, 4, 5]).buffer)).toEqual({});
  });
});

describe("MP4/M4A 标签解析", () => {
  function mp4Fixture(): ArrayBuffer {
    const ilst = concatBytes(
      atom(NAM, atom("data", concatBytes(u32beBytes(1), u32beBytes(0), bytes("MP4 标题歌")))),
      atom(ART, atom("data", concatBytes(u32beBytes(1), u32beBytes(0), bytes("MP4 艺人")))),
      atom("covr", atom("data", concatBytes(u32beBytes(13), u32beBytes(0), FAKE_JPEG))),
    );
    const meta = atom("meta", concatBytes(new Uint8Array(4), atom("ilst", ilst)));
    const moov = atom("moov", concatBytes(atom("udta", meta)));
    return concatBytes(atom("ftyp", bytes("isom")), moov).buffer as ArrayBuffer;
  }

  it("解析 ©nam/©ART/covr", async () => {
    const tags = await readAudioTags(new File([mp4Fixture()], "song.m4a"));
    expect(tags.title).toBe("MP4 标题歌");
    expect(tags.artist).toBe("MP4 艺人");
    expect(tags.coverBlob?.type).toBe("image/jpeg");
    expect(tags.coverBlob?.size).toBe(FAKE_JPEG.length);
  });

  it("moov 缺失（预算外）返回空对象", () => {
    expect(parseMp4Tags(atom("ftyp", bytes("isom")).buffer as ArrayBuffer)).toEqual({});
  });

  it("covr 的 PNG 类型指示（14）映射 image/png", () => {
    const ilst = atom("covr", atom("data", concatBytes(u32beBytes(14), u32beBytes(0), FAKE_PNG)));
    const meta = atom("meta", concatBytes(new Uint8Array(4), atom("ilst", ilst)));
    const buf = concatBytes(atom("ftyp", bytes("isom")), atom("moov", atom("udta", meta))).buffer as ArrayBuffer;
    expect(parseMp4Tags(buf).coverBlob?.type).toBe("image/png");
  });
});

/** Phase 2 媒体层纯逻辑单元测试：调度换算、迟到判定、ICE 配置、对等连接目标 diff、本地源定位。 */
import { describe, expect, it } from "vitest";
import { computeSegmentTiming, isLateJoin, LATE_JOIN_THRESHOLD_MS } from "../media/audio-clock";
import { parseIceServers, DEFAULT_ICE_SERVERS } from "../media/webrtc/ice-config";
import { diffPeerTargets } from "../media/webrtc/peer-targets";
import { BufferLocatableSource, bufferOffsetSec } from "../media/local-source/buffer-source";

describe("computeSegmentTiming", () => {
  it("startAt 在未来：按 AudioContext 时钟安排起播，偏移即起始位置", () => {
    const t = computeSegmentTiming({
      startAtMs: 1_000_000,
      startPositionMs: 2_500,
      serverNowMs: 995_000,
      ctxCurrentTimeSec: 100,
    });
    expect(t.startsLate).toBe(false);
    expect(t.whenCtxSec).toBeCloseTo(105, 6);
    expect(t.offsetSec).toBeCloseTo(2.5, 6);
  });

  it("startAt 已过（强制开始晚到）：立即起播并按迟到时长顺延偏移", () => {
    const t = computeSegmentTiming({
      startAtMs: 1_000_000,
      startPositionMs: 0,
      serverNowMs: 1_002_500,
      ctxCurrentTimeSec: 100,
    });
    expect(t.startsLate).toBe(true);
    expect(t.whenCtxSec).toBe(100);
    expect(t.offsetSec).toBeCloseTo(2.5, 6);
  });

  it("迟到叠加起始位置：偏移相加且不为负", () => {
    const t = computeSegmentTiming({
      startAtMs: 1_000_000,
      startPositionMs: 1_000,
      serverNowMs: 1_002_000,
      ctxCurrentTimeSec: 50,
    });
    expect(t.offsetSec).toBeCloseTo(3, 6);

    const clamped = computeSegmentTiming({
      startAtMs: 1_000_000,
      startPositionMs: 0,
      serverNowMs: 1_002_000,
      ctxCurrentTimeSec: 50,
    });
    expect(clamped.offsetSec).toBeCloseTo(2, 6);
  });
});

describe("isLateJoin", () => {
  it("歌曲开始超过阈值才算迟到", () => {
    expect(isLateJoin({ playing: true, startAtMs: 1_000_000, serverNowMs: 1_000_000 + LATE_JOIN_THRESHOLD_MS + 1 })).toBe(true);
    expect(isLateJoin({ playing: true, startAtMs: 1_000_000, serverNowMs: 1_000_000 + LATE_JOIN_THRESHOLD_MS })).toBe(false);
    expect(isLateJoin({ playing: true, startAtMs: null, serverNowMs: 9_999_999 })).toBe(false);
    expect(isLateJoin({ playing: false, startAtMs: 1_000_000, serverNowMs: 9_999_999 })).toBe(false);
  });
});

describe("parseIceServers", () => {
  it("未配置时回退默认公共 STUN", () => {
    const empty = parseIceServers(undefined);
    expect(empty.source).toBe("default");
    expect(empty.error).toBeNull();
    expect(empty.servers).toEqual(DEFAULT_ICE_SERVERS);
  });

  it("合法 JSON 数组被采用（含 TURN 兜底配置）", () => {
    const raw = JSON.stringify([
      { urls: "stun:stun.example.com:3478" },
      { urls: ["turn:turn.example.com:3478"], username: "user", credential: "placeholder" },
    ]);
    const parsed = parseIceServers(raw);
    expect(parsed.source).toBe("env");
    expect(parsed.error).toBeNull();
    expect(parsed.servers).toHaveLength(2);
    expect((parsed.servers[1] as { username?: string }).username).toBe("user");
  });

  it("非法 JSON / 非数组 / 缺 urls 时回退默认并给出原因", () => {
    expect(parseIceServers("{bad").error).toBeTruthy();
    expect(parseIceServers('{"urls":"stun:x"}').error).toBeTruthy();
    expect(parseIceServers('[{"username":"u"}]').error).toBeTruthy();
    for (const bad of ['{"bad"', '{"urls":"stun:x"}', '[{"username":"u"}]']) {
      expect(parseIceServers(bad).servers).toEqual(DEFAULT_ICE_SERVERS);
    }
  });
});

describe("diffPeerTargets", () => {
  it("计算需要创建与关闭的成员连接", () => {
    const { create, close } = diffPeerTargets(["a", "b", "c"], ["b", "d"]);
    expect(create).toEqual(["a", "c"]);
    expect(close).toEqual(["d"]);
  });
});

describe("BufferLocatableSource", () => {
  const fakeBuffer = { duration: 2.5 } as unknown as AudioBuffer;

  it("定位夹取到 [0, durationMs] 并换算偏移秒", () => {
    const source = new BufferLocatableSource(fakeBuffer);
    expect(source.durationMs).toBe(2500);
    void source.seekTo(-5);
    expect(source.positionMs).toBe(0);
    void source.seekTo(9_999_999);
    expect(source.positionMs).toBe(2500);
    expect(bufferOffsetSec(1500, 2500)).toBeCloseTo(1.5, 6);
  });

  it("release 后 durationMs 归零且不可再连接", () => {
    const source = new BufferLocatableSource(fakeBuffer);
    source.release();
    expect(source.durationMs).toBe(0);
    expect(() => source.connectTo({} as BaseAudioContext)).toThrow();
  });
});

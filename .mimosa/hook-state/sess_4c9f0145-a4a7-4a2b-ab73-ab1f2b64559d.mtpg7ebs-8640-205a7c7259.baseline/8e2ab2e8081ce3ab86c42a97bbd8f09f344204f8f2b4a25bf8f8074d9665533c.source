import { describe, expect, it } from "vitest";
import { driftExceedsTolerance, type LocatableAudioSource } from "../src";

describe("driftExceedsTolerance", () => {
  it("超出容差返回 true", () => {
    expect(driftExceedsTolerance(10500, 10000, 400)).toBe(true);
    expect(driftExceedsTolerance(9500, 10000, 400)).toBe(true);
  });

  it("容差内返回 false（含边界）", () => {
    expect(driftExceedsTolerance(10400, 10000, 400)).toBe(false);
    expect(driftExceedsTolerance(9600, 10000, 400)).toBe(false);
    expect(driftExceedsTolerance(10000, 10000, 0)).toBe(false);
  });

  it("非法输入返回 false，不抛错", () => {
    expect(driftExceedsTolerance(Number.NaN, 10000, 400)).toBe(false);
    expect(driftExceedsTolerance(10000, Number.POSITIVE_INFINITY, 400)).toBe(false);
    expect(driftExceedsTolerance(10000, 10000, Number.NaN)).toBe(false);
    expect(driftExceedsTolerance(10000, 10000, -1)).toBe(false);
  });
});

describe("LocatableAudioSource 接口", () => {
  it("实现方必须提供 durationMs/seekTo/connectTo/release", async () => {
    let soughtTo = -1;
    const released: string[] = [];
    const source: LocatableAudioSource = {
      durationMs: 1000,
      seekTo: async (positionMs) => {
        soughtTo = positionMs;
      },
      connectTo: () => ({}) as AudioNode,
      release: () => {
        released.push("released");
      },
    };
    await source.seekTo(500);
    expect(soughtTo).toBe(500);
    source.release();
    expect(released).toEqual(["released"]);
  });
});

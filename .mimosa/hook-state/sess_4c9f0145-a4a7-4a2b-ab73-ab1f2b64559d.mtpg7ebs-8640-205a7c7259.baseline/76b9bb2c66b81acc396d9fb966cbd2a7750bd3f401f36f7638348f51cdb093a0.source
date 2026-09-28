/**
 * 音频段调度纯函数（D-011）：把控制面的服务器时钟目标（startAtMs）
 * 换算成房主 AudioContext 时钟上的起播时刻与缓冲内偏移。
 * 与 Web Audio API 解耦，便于单元测试。
 */

export interface SegmentTiming {
  /** AudioContext.currentTime 上的起播时刻（秒）；迟到时为当前时刻。 */
  whenCtxSec: number;
  /** AudioBuffer 内的起始偏移（秒）；迟到时按经过时长顺延并夹取到 0。 */
  offsetSec: number;
  /** startAtMs 已经过（例如强制开始晚到）时为 true。 */
  startsLate: boolean;
}

export interface SegmentTimingInput {
  /** 统一开始时间（服务器时钟，Unix 毫秒）。 */
  startAtMs: number;
  /** 统一开始位置（毫秒）。 */
  startPositionMs: number;
  /** 计算时刻的服务器时钟估计值（Unix 毫秒）。 */
  serverNowMs: number;
  /** AudioContext.currentTime（秒）。 */
  ctxCurrentTimeSec: number;
}

export function computeSegmentTiming(input: SegmentTimingInput): SegmentTiming {
  const delayMs = input.startAtMs - input.serverNowMs;
  if (delayMs > 0) {
    return {
      whenCtxSec: input.ctxCurrentTimeSec + delayMs / 1000,
      offsetSec: Math.max(0, input.startPositionMs) / 1000,
      startsLate: false,
    };
  }
  const lateMs = -delayMs;
  return {
    whenCtxSec: input.ctxCurrentTimeSec,
    offsetSec: Math.max(0, input.startPositionMs + lateMs) / 1000,
    startsLate: true,
  };
}

/** 迟到成员判定：加入/重连时歌曲已开始超过该阈值才提示“当前歌曲已开始”。 */
export const LATE_JOIN_THRESHOLD_MS = 3_000;

export function isLateJoin(input: { playing: boolean; startAtMs: number | null; serverNowMs: number }): boolean {
  if (!input.playing || input.startAtMs == null) return false;
  return input.serverNowMs - input.startAtMs > LATE_JOIN_THRESHOLD_MS;
}

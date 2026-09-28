/**
 * 可定位音频源：房主本地文件解码后的表示（docs/01-architecture.md「媒体面」）。
 *
 * 迟到/卡顿成员重新同步时，房主需要从目标时间戳重建音频流，
 * 因此源必须支持按位置定位，而不仅是顺序播放。
 * Phase 2 由 apps/web/src/media/local-source 提供实现。
 */
export interface LocatableAudioSource {
  /** 总时长，毫秒；解码失败时为 0。 */
  readonly durationMs: number;
  /** 定位到目标位置；超界时夹取到 [0, durationMs]。 */
  seekTo(positionMs: number): Promise<void>;
  /** 将音频接入 Web Audio 图，供 MediaStreamAudioDestinationNode 采集。 */
  connectTo(context: BaseAudioContext): AudioNode;
  /** 释放解码缓冲与节点引用；调用后实例不可复用。 */
  release(): void;
}

/** 播放中的可定位音频源在给定时刻所处的位置，毫秒。 */
export type PositionReader = () => number;

/**
 * 判断成员本地进度是否超出容差，需要提示重新同步。
 * 对应文档规则：只有“明显漂移”才提示校正；轻微偏差不打扰。
 */
export function driftExceedsTolerance(
  localPositionMs: number,
  authoritativePositionMs: number,
  toleranceMs: number,
): boolean {
  if (!Number.isFinite(localPositionMs) || !Number.isFinite(authoritativePositionMs)) return false;
  if (toleranceMs < 0 || !Number.isFinite(toleranceMs)) return false;
  return Math.abs(localPositionMs - authoritativePositionMs) > toleranceMs;
}

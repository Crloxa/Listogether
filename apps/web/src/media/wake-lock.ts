/**
 * 屏幕常亮（Phase 4）：房主播放中尝试 Screen Wake Lock，减少移动端息屏导致的
 * AudioContext 节流。API 不存在或被拒绝时静默降级（纯增强，无功能依赖）。
 */

export interface WakeLockHandle {
  /** 释放锁（页面隐藏/停止播放时调用）。 */
  release(): void;
}

type WakeLockSentinelLike = { release(): Promise<void>; addEventListener(type: string, fn: () => void): void };
type WakeLockApiLike = { request(type: "screen"): Promise<WakeLockSentinelLike> };

/** 从 navigator 取 wakeLock API（不存在返回 null；注入便于测试）。 */
export function getWakeLockApi(nav: Navigator | null = globalThis.navigator): WakeLockApiLike | null {
  const candidate = (nav as unknown as { wakeLock?: WakeLockApiLike } | null)?.wakeLock;
  return candidate ?? null;
}

/** 请求屏幕常亮；成功返回 handle，失败/不支持返回 null。 */
export async function requestWakeLock(nav: Navigator | null = globalThis.navigator): Promise<WakeLockHandle | null> {
  const api = getWakeLockApi(nav);
  if (!api) return null;
  try {
    const sentinel = await api.request("screen");
    // 系统回收（如用户强制息屏）后自动清理调用方的引用语义
    sentinel.addEventListener("release", () => {});
    return {
      release: () => {
        void sentinel.release().catch(() => {});
      },
    };
  } catch {
    return null;
  }
}

/**
 * 房主上行带宽估算（D-020，技术设计容量目标的 UI 落地）：
 * 每个成员一条独立音频流，房主上行 ≈ 单流码率 × 已连接成员数。
 * 码率按"当前曲目文件大小×8÷时长"估算（解码后时长与文件大小即可，无需解封装）。
 */

/** 上行估算警告阈值：超过即显示明确提示（默认 10 Mbps）。 */
export const HOST_UPSTREAM_WARN_KBPS = 10_000;

/** 单流码率（kbps）；文件大小或时长非法时返回 null（不猜）。 */
export function estimateTrackKbps(fileSizeBytes: number, durationMs: number): number | null {
  if (!Number.isFinite(fileSizeBytes) || !Number.isFinite(durationMs)) return null;
  if (fileSizeBytes <= 0 || durationMs <= 0) return null;
  return Math.round((fileSizeBytes * 8) / (durationMs / 1000) / 1000);
}

/** 房主总上行（kbps）= 单流码率 × 连接成员数；无有效估算返回 null。 */
export function estimateHostUpstreamKbps(
  file: { size: number } | null | undefined,
  durationMs: number,
  connectedPeers: number,
): number | null {
  const kbps = file ? estimateTrackKbps(file.size, durationMs) : null;
  if (kbps == null || connectedPeers <= 0) return null;
  return kbps * connectedPeers;
}

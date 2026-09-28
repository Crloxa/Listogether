/**
 * ICE 服务器配置（D-010/D-018）：
 * - 运行时来源：进入房间后从 Relay `GET /api/webrtc/ice` 拉取（TURN 短期凭据，周期刷新）；
 * - 静态回退：Relay 不可达时用构建期 VITE_ICE_SERVERS，再回退默认公共 STUN；
 * - ICE 建联不因配置拉取失败而阻塞（先回退后纠正）。
 */

export interface ParsedIceServers {
  servers: RTCIceServer[];
  source: "runtime" | "env" | "default";
  /** 配置存在但非法时的原因；servers 已回退默认值。 */
  error: string | null;
}

export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: ["stun:stun.l.google.com:19302"] }];

/** 校验 RTCIceServer 数组形状；合法返回 null，非法返回原因。 */
export function validateIceServerArray(parsed: unknown): string | null {
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return "必须是非空 RTCIceServer 数组";
  }
  for (const item of parsed) {
    const urls = (item as { urls?: unknown })?.urls;
    const isUrls = typeof urls === "string" || (Array.isArray(urls) && urls.every((u) => typeof u === "string"));
    if (!isUrls) {
      return "每项都需要 urls（字符串或字符串数组）";
    }
  }
  return null;
}

/** 运行时（Relay 下发）的 ICE 配置；null 表示尚未拉取或拉取失败。 */
let runtime: { servers: RTCIceServer[]; turnEnabled: boolean } | null = null;

/** Relay 下发成功后调用（RoomPage 拉取周期内）；非法数组忽略。 */
export function setRuntimeIceServers(servers: RTCIceServer[], turnEnabled: boolean): void {
  const invalid = validateIceServerArray(servers);
  if (invalid) return;
  runtime = { servers, turnEnabled };
}

/** 测试与页面卸载清理用。 */
export function clearRuntimeIceServers(): void {
  runtime = null;
}

export function runtimeTurnEnabled(): boolean {
  return runtime?.turnEnabled ?? false;
}

/** 当前生效的 ICE 配置：运行时 > 构建期环境变量 > 默认 STUN。 */
export function getActiveIceServers(rawEnv: string | null | undefined): ParsedIceServers {
  if (runtime) {
    return { servers: runtime.servers, source: "runtime", error: null };
  }
  if (rawEnv == null || !rawEnv.trim()) {
    return { servers: DEFAULT_ICE_SERVERS, source: "default", error: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawEnv);
  } catch (err) {
    return { servers: DEFAULT_ICE_SERVERS, source: "default", error: "VITE_ICE_SERVERS 不是合法 JSON：" + String(err) };
  }
  const invalid = validateIceServerArray(parsed);
  if (invalid) {
    return { servers: DEFAULT_ICE_SERVERS, source: "default", error: "VITE_ICE_SERVERS " + invalid };
  }
  return { servers: parsed as RTCIceServer[], source: "env", error: null };
}

/** 兼容旧调用点：等价于 getActiveIceServers(rawEnv)。 */
export function parseIceServers(raw: string | null | undefined): ParsedIceServers {
  return getActiveIceServers(raw);
}

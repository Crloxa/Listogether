/** Relay 房间 REST API 客户端。错误统一抛出 ApiError（code 与协议错误码一致）。 */
import { relayBaseUrl } from "../../app/relay-config";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(method: string, path: string, body?: unknown, sessionToken?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (sessionToken) headers["Authorization"] = `Bearer ${sessionToken}`;
  let res: Response;
  try {
    res = await fetch(`${relayBaseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "NETWORK", "无法连接 Relay 服务，请确认 apps/relay 已启动");
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof data.code === "string" ? data.code : "INTERNAL";
    const message = typeof data.message === "string" ? data.message : "请求失败";
    throw new ApiError(res.status, code, message);
  }
  return data as T;
}

export interface CreateRoomResponse {
  roomId: string;
  roomName: string;
  inviteToken: string;
  sessionToken: string;
  memberId: string;
  role: string;
  maxMembers: number;
  passwordSet: boolean;
  serverTimeMs: number;
}

export interface JoinRoomResponse {
  roomId: string;
  sessionToken: string;
  memberId: string;
  role: string;
  serverTimeMs: number;
}

export interface RoomInfoResponse {
  roomId: string;
  exists: boolean;
  locked: boolean;
  memberCount: number;
  maxMembers: number;
  needsPassword: boolean;
}

export interface IceConfigResponse {
  iceServers: { urls: string | string[]; username?: string; credential?: string }[];
  turnEnabled: boolean;
  ttlSeconds: number;
}

export const iceApi = {
  /** 拉取 ICE 配置（TURN 短期凭据或默认 STUN，D-018）；失败由调用方回退静态配置。 */
  fetchConfig(sessionToken: string) {
    return request<IceConfigResponse>("GET", "/api/webrtc/ice", sessionToken);
  },
};

export const roomApi = {
  create(opts: { hostName: string; roomName?: string; password?: string; maxMembers?: number }) {
    return request<CreateRoomResponse>("POST", "/api/rooms", opts);
  },
  join(roomId: string, opts: { inviteToken: string; name: string; password?: string }) {
    return request<JoinRoomResponse>("POST", `/api/rooms/${encodeURIComponent(roomId)}/sessions`, opts);
  },
  info(roomId: string) {
    return request<RoomInfoResponse>("GET", `/api/rooms/${encodeURIComponent(roomId)}`);
  },
  lock(roomId: string, sessionToken: string, locked: boolean) {
    return request<{ locked: boolean }>("POST", `/api/rooms/${encodeURIComponent(roomId)}/lock`, { locked }, sessionToken);
  },
  kick(roomId: string, sessionToken: string, memberId: string) {
    return request<{ kicked: boolean }>(
      "POST",
      `/api/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(memberId)}/kick`,
      {},
      sessionToken,
    );
  },
  setRole(roomId: string, sessionToken: string, memberId: string, role: "co_dj" | "listener") {
    return request<{ role: string }>(
      "POST",
      `/api/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(memberId)}/role`,
      { role },
      sessionToken,
    );
  },
  close(roomId: string, sessionToken: string) {
    return request<{ closed: boolean }>("POST", `/api/rooms/${encodeURIComponent(roomId)}/close`, {}, sessionToken);
  },
};

/** 把协议错误码映射为可操作的中文提示。 */
export function describeApiError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "ROOM_LOCKED":
        return "房间已锁房，暂不接受新成员。请联系房主解锁。";
      case "ROOM_FULL":
        return "房间人数已满，无法加入。";
      case "ROOM_NOT_FOUND":
        return "房间不存在或已关闭。请确认邀请链接是否过期。";
      case "INVALID_TOKEN":
        return "邀请链接无效或已失效。";
      case "UNAUTHORIZED":
        return "房间密码错误，或没有执行该操作的权限。";
      case "NETWORK":
        return err.message;
      default:
        return err.message || "请求失败，请稍后重试。";
    }
  }
  return "未知错误，请稍后重试。";
}

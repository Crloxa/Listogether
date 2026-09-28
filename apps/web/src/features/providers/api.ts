/** 平台链接解析与 OAuth 的 Relay API 客户端（Phase 4，D-014/D-015）。 */
import { relayBaseUrl } from "../../app/relay-config";
import { ApiError } from "../room/api";
import type { Playability, Platform } from "@listogether/protocol";

async function request<T>(method: string, path: string, sessionToken: string | undefined, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (sessionToken) headers["Authorization"] = "Bearer " + sessionToken;
  let res: Response;
  try {
    res = await fetch(relayBaseUrl + path, {
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

// ---- 链接解析（D-014） ----

export interface ResolveResponse {
  platform: Platform;
  externalId?: string;
  title?: string;
  artist?: string;
  album?: string;
  durationMs?: number;
  coverUrl?: string;
  playability: Playability;
  message?: string;
  normalizedUrl: string;
}

export const providerApi = {
  /** 房主解析平台链接；网络/平台失败以 ApiError 抛出（code: PLATFORM_UNSUPPORTED 等）。 */
  resolve(roomId: string, sessionToken: string, url: string) {
    return request<ResolveResponse>("POST", "/api/rooms/" + encodeURIComponent(roomId) + "/links/resolve", sessionToken, { url });
  },
};

// ---- OAuth（D-015） ----

export interface OAuthProviderStatus {
  id: string;
  configured: boolean;
  connected: boolean;
  userLabel?: string;
  scopes?: string[];
}

export const oauthApi = {
  list(sessionToken: string) {
    return request<{ providers: OAuthProviderStatus[] }>("GET", "/api/oauth/providers", sessionToken);
  },
  start(sessionToken: string, providerId: string) {
    return request<{ authorizeUrl: string }>(
      "POST",
      "/api/oauth/" + encodeURIComponent(providerId) + "/start",
      sessionToken,
    );
  },
  disconnect(sessionToken: string, providerId: string) {
    return request<{ disconnected: boolean }>(
      "POST",
      "/api/oauth/" + encodeURIComponent(providerId) + "/disconnect",
      sessionToken,
    );
  },
};

/** OAuth/解析错误 → 可操作提示（UI 共用）。 */
export function describeProviderError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "PLATFORM_UNSUPPORTED":
        return err.message || "暂不支持该平台链接。";
      case "PROVIDER_UNAVAILABLE":
        return err.message || "平台暂时不可达（网络原因或被拦截），稍后再试。";
      case "OAUTH_NOT_CONFIGURED":
        return "该平台的账号登录未配置。请在 Relay 侧设置 LISTO_OAUTH_* 环境变量（见 README）。";
      case "OAUTH_DENIED":
        return "你在平台页面取消了授权。可重试，或跳过登录继续使用。";
      case "OAUTH_STATE_MISMATCH":
        return "授权状态校验失败（可能超时或重复回调），请重新发起。";
      case "RATE_LIMITED":
        return "操作太频繁，请稍后再试。";
      case "UNAUTHORIZED":
        return "只有房主可以执行该操作。";
      case "NETWORK":
        return err.message;
      default:
        return err.message || "请求失败，请稍后重试。";
    }
  }
  return "未知错误，请稍后重试。";
}

/** 平台账号连接面板（Phase 4，D-015）：连接状态只含打码标识，token 永远不到浏览器。 */
import { useCallback, useEffect, useState } from "react";
import { describeProviderError, oauthApi, type OAuthProviderStatus } from "./api";

const PLATFORM_LABEL: Record<string, string> = {
  spotify: "Spotify",
  netease: "网易云音乐",
  qqmusic: "QQ 音乐",
};

export interface OAuthPanelProps {
  sessionToken: string;
}

export default function OAuthPanel({ sessionToken }: OAuthPanelProps) {
  const [providers, setProviders] = useState<OAuthProviderStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** 最近一次授权跳转地址：弹窗被拦截时的回退入口（新标签页/复制打开均可）。 */
  const [fallbackUrl, setFallbackUrl] = useState<{ provider: string; url: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await oauthApi.list(sessionToken);
      setProviders(res.providers);
      setError(null);
    } catch (err) {
      setError(describeProviderError(err));
    }
  }, [sessionToken]);

  useEffect(() => {
    void refresh();
    // 弹窗授权完成后回到本页时刷新状态
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function connect(providerId: string) {
    setBusy(providerId);
    setError(null);
    try {
      const res = await oauthApi.start(sessionToken, providerId);
      setFallbackUrl({ provider: providerId, url: res.authorizeUrl });
      // 授权在新窗口完成；回调解耦（state 绑定由 Relay 管理）。
      // window.open 返回 null = 弹窗被拦截：保留 fallbackUrl 供用户手动打开。
      const popup = window.open(res.authorizeUrl, "_blank", "noopener,width=520,height=720");
      if (!popup) {
        setError("弹窗可能被浏览器拦截：请点击下方链接在新标签页完成授权。");
      }
    } catch (err) {
      setError(describeProviderError(err));
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(providerId: string) {
    setBusy(providerId);
    setError(null);
    setFallbackUrl(null);
    try {
      await oauthApi.disconnect(sessionToken, providerId);
      await refresh();
    } catch (err) {
      setError(describeProviderError(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card" data-testid="oauth-panel">
      <h2>平台账号</h2>
      <p className="hint">登录状态只显示打码标识；令牌仅保存在 Relay 内存，不进入房间消息或邀请链接。</p>
      {error && (
        <p role="alert" className="banner warn" data-testid="oauth-error">
          {error}
        </p>
      )}
      {fallbackUrl && (
        <p className="hint" data-testid="oauth-fallback">
          授权未完成？{" "}
          <a href={fallbackUrl.url} target="_blank" rel="noreferrer" data-testid="oauth-fallback-link">
            点此在新标签页完成 {PLATFORM_LABEL[fallbackUrl.provider] ?? fallbackUrl.provider} 授权
          </a>{" "}
          （链接 10 分钟内有效）
        </p>
      )}
      {providers === null ? (
        <p className="hint" data-testid="oauth-loading">
          正在获取平台配置…
        </p>
      ) : providers.length === 0 ? (
        <p className="hint" data-testid="oauth-empty">
          没有可用的平台账号登录（Relay 未配置任何 OAuth 凭证）。
        </p>
      ) : (
        <ul data-testid="oauth-list">
          {providers.map((p) => (
            <li key={p.id} data-testid={"oauth-" + p.id}>
              {PLATFORM_LABEL[p.id] ?? p.id}：
              {!p.configured ? (
                <span className="hint">未配置（需要 Relay 环境变量）</span>
              ) : p.connected ? (
                <>
                  <span className="badge" data-testid="oauth-connected">
                    已连接 {p.userLabel}
                  </span>{" "}
                  <button type="button" onClick={() => void disconnect(p.id)} disabled={busy === p.id}>
                    断开
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => void connect(p.id)} disabled={busy === p.id} data-testid="oauth-connect-btn">
                  {busy === p.id ? "跳转中…" : "连接账号"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

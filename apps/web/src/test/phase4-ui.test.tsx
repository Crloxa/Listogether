/** Phase 4 UI 测试：平台链接解析卡片与 OAuth 面板（fetch 桩驱动）。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import LinkResolver from "../features/providers/LinkResolver";
import OAuthPanel from "../features/providers/OAuthPanel";
import { stubFetchApi } from "./helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LinkResolver（D-014）", () => {
  it("不认识的平台：客户端即时拒绝，不发请求", async () => {
    const fetchMock = stubFetchApi([]);
    render(<LinkResolver roomId="r" sessionToken="t" onAddToLibrary={() => {}} />);
    fireEvent.change(screen.getByTestId("link-input"), { target: { value: "https://unknown.example/x" } });
    fireEvent.click(screen.getByTestId("link-resolve-btn"));
    expect(await screen.findByTestId("link-error")).toHaveTextContent("暂不支持该平台");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("识别成功：显示元数据与可用性，确认后加入曲库", async () => {
    stubFetchApi([
      {
        url: "/links/resolve",
        method: "POST",
        body: {
          platform: "netease",
          externalId: "347230",
          title: "海阔天空",
          artist: "Beyond",
          durationMs: 326000,
          playability: "needs_login",
          message: "平台标注该曲目需登录/会员",
          normalizedUrl: "https://music.163.com/song?id=347230",
        },
      },
    ]);
    const added: string[] = [];
    render(
      <LinkResolver
        roomId="r"
        sessionToken="t"
        onAddToLibrary={(track) => added.push(track.trackId)}
      />,
    );
    fireEvent.change(screen.getByTestId("link-input"), { target: { value: "https://music.163.com/song?id=347230" } });
    fireEvent.click(screen.getByTestId("link-resolve-btn"));
    expect(await screen.findByTestId("link-result")).toHaveTextContent("海阔天空");
    expect(screen.getByTestId("link-playability")).toHaveTextContent("平台需登录/会员确认");
    fireEvent.click(screen.getByTestId("link-add-btn"));
    expect(await screen.findByTestId("link-added")).toBeInTheDocument();
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/^ext-netease-/);
  });

  it("平台不可达：502 转为可解释提示", async () => {
    stubFetchApi([
      {
        url: "/links/resolve",
        method: "POST",
        status: 502,
        body: { code: "PROVIDER_UNAVAILABLE", message: "provider unavailable: 请求失败" },
      },
    ]);
    render(<LinkResolver roomId="r" sessionToken="t" onAddToLibrary={() => {}} />);
    fireEvent.change(screen.getByTestId("link-input"), { target: { value: "https://music.163.com/song?id=1" } });
    fireEvent.click(screen.getByTestId("link-resolve-btn"));
    // 服务端根因消息透传（可解释失败）
    expect(await screen.findByTestId("link-error")).toHaveTextContent("provider unavailable");
  });
});

describe("OAuthPanel（D-015）", () => {
  it("未配置任何 provider：显示提示", async () => {
    stubFetchApi([
      { url: "/api/oauth/providers", method: "GET", body: { providers: [] } },
    ]);
    render(<OAuthPanel sessionToken="t" />);
    expect(await screen.findByTestId("oauth-empty")).toHaveTextContent("没有可用的平台账号登录");
  });

  it("已配置未连接：显示连接按钮；未配置项显示未配置", async () => {
    stubFetchApi([
      {
        url: "/api/oauth/providers",
        method: "GET",
        body: {
          providers: [
            { id: "spotify", configured: true, connected: false, scopes: ["user-read-private"] },
            { id: "netease", configured: false },
          ],
        },
      },
    ]);
    render(<OAuthPanel sessionToken="t" />);
    expect(await screen.findByTestId("oauth-spotify")).toHaveTextContent("连接账号");
    expect(screen.getByTestId("oauth-netease")).toHaveTextContent("未配置");
  });

  it("已连接：显示打码标识与断开按钮", async () => {
    stubFetchApi([
      {
        url: "/api/oauth/providers",
        method: "GET",
        body: {
          providers: [{ id: "spotify", configured: true, connected: true, userLabel: "小…" }],
        },
      },
    ]);
    render(<OAuthPanel sessionToken="t" />);
    const item = await screen.findByTestId("oauth-spotify");
    expect(item).toHaveTextContent("已连接 小…");
    expect(item).toHaveTextContent("断开");
  });

  it("未配置时点连接：503 转为可操作提示", async () => {
    stubFetchApi([
      { url: "/api/oauth/providers", method: "GET", body: { providers: [{ id: "spotify", configured: true, connected: false }] } },
      { url: "/api/oauth/spotify/start", method: "POST", status: 503, body: { code: "OAUTH_NOT_CONFIGURED", message: "未配置" } },
    ]);
    render(<OAuthPanel sessionToken="t" />);
    const connect = await screen.findByTestId("oauth-connect-btn");
    fireEvent.click(connect);
    await waitFor(() => expect(screen.getByTestId("oauth-error")).toHaveTextContent("未配置"));
  });
});

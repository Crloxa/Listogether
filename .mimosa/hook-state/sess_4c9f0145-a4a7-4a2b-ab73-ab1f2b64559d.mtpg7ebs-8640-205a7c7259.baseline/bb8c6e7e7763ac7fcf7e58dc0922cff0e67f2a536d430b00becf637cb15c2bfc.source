import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../app/App";
import RelayHealth from "../app/RelayHealth";
import { stubFetchApi, stubRelayHealth } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState(null, "", "/");
});

describe("App 路由", () => {
  it("首页渲染创建房间入口和 Relay 状态", async () => {
    stubRelayHealth({ status: "ok", version: "0.0.1" });
    render(<App />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Listogether");
    expect(screen.getByTestId("create-room")).toBeInTheDocument();
    expect(await screen.findByText(/Relay 已连接/)).toBeInTheDocument();
  });

  it("/join 缺少邀请参数时提示完整链接", () => {
    window.history.pushState(null, "", "/join");
    render(<App />);
    expect(screen.getByTestId("invite-missing")).toBeInTheDocument();
  });
});

describe("RelayHealth", () => {
  it("healthz 正常时显示已连接和版本", async () => {
    stubRelayHealth({ status: "ok", version: "0.0.1" });
    render(<RelayHealth />);
    expect(await screen.findByText(/Relay 已连接（版本 0.0.1）/)).toBeInTheDocument();
  });

  it("healthz 不可达时显示可操作的失败提示", async () => {
    stubRelayHealth(null, new Error("connection refused"));
    render(<RelayHealth />);
    expect(await screen.findByText(/Relay 无法连接/)).toBeInTheDocument();
    expect(screen.getByText(/请确认 apps\/relay 已启动/)).toBeInTheDocument();
  });

  it("healthz 返回非 ok 状态时按失败处理", async () => {
    stubRelayHealth({ status: "degraded" });
    render(<RelayHealth />);
    expect(await screen.findByText(/Relay 无法连接/)).toBeInTheDocument();
  });
});

describe("房间 API 客户端错误映射", () => {
  it("describeApiError 把 ROOM_LOCKED 映射为可操作提示", async () => {
    stubFetchApi([
      { url: "/api/rooms/r1/sessions", method: "POST", status: 403, body: { code: "ROOM_LOCKED", message: "locked" } },
    ]);
    const { roomApi, describeApiError } = await import("../features/room/api");
    try {
      await roomApi.join("r1", { inviteToken: "t", name: "n" });
      throw new Error("should throw");
    } catch (err) {
      expect(describeApiError(err)).toContain("锁房");
    }
  });
});

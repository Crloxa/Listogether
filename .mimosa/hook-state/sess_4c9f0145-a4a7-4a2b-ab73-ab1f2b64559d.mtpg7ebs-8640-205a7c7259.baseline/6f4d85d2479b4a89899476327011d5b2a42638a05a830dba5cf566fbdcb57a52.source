import { act } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import HomePage from "../app/HomePage";
import JoinPage from "../features/room/JoinPage";
import RoomPage from "../features/room/RoomPage";
import { FakeWebSocket, stubFetchApi, stubWebSocket } from "./helpers";
import { loadSession, saveSession } from "../features/room/session";

function goto(path: string) {
  window.history.pushState(null, "", path);
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  goto("/");
});

describe("HomePage 创建房间", () => {
  it("提交后保存会话并跳转到房间页", async () => {
    stubFetchApi([
      { url: "/healthz", body: { status: "ok", version: "0.0.1" } },
      {
        url: "/api/rooms",
        method: "POST",
        body: {
          roomId: "room-xyz",
          roomName: "朋友的音乐房间",
          inviteToken: "inv-1",
          sessionToken: "sess-1",
          memberId: "m-host",
          role: "host",
          maxMembers: 16,
          passwordSet: false,
          serverTimeMs: 123,
        },
      },
    ]);
    render(<HomePage />);
    fireEvent.change(screen.getByTestId("host-name"), { target: { value: "阿明" } });
    fireEvent.click(screen.getByTestId("create-room"));

    await waitFor(() => {
      expect(loadSession("room-xyz")).not.toBeNull();
    });
    const session = loadSession("room-xyz")!;
    expect(session.sessionToken).toBe("sess-1");
    expect(session.role).toBe("host");
    expect(session.inviteToken).toBe("inv-1");
  });

  it("创建失败时展示可操作的错误", async () => {
    stubFetchApi([
      { url: "/healthz", body: { status: "ok" } },
      { url: "/api/rooms", method: "POST", rejectWith: new Error("down") },
    ]);
    render(<HomePage />);
    fireEvent.change(screen.getByTestId("host-name"), { target: { value: "阿明" } });
    fireEvent.click(screen.getByTestId("create-room"));
    expect(await screen.findByTestId("create-error")).toHaveTextContent(/无法连接 Relay 服务/);
  });
});

describe("JoinPage 加入房间", () => {
  it("链接不完整时给出明确提示", () => {
    goto("/join");
    render(<JoinPage />);
    expect(screen.getByTestId("invite-missing")).toBeInTheDocument();
  });

  it("需要密码的房间展示密码输入，密码错误提示可操作", async () => {
    goto("/join?room=room-1#i=tok-1");
    stubFetchApi([
      {
        url: "/api/rooms/room-1",
        method: "GET",
        body: { roomId: "room-1", exists: true, locked: false, memberCount: 1, maxMembers: 16, needsPassword: true },
      },
      {
        url: "/api/rooms/room-1/sessions",
        method: "POST",
        status: 403,
        body: { code: "UNAUTHORIZED", message: "房间密码错误" },
      },
    ]);
    render(<JoinPage />);
    expect(await screen.findByTestId("join-password")).toBeInTheDocument();
    expect(screen.getByTestId("join-room-meta")).toHaveTextContent(/需要密码/);

    fireEvent.change(screen.getByTestId("join-name"), { target: { value: "小明" } });
    fireEvent.change(screen.getByTestId("join-password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByTestId("join-room"));
    expect(await screen.findByTestId("join-error")).toHaveTextContent(/密码错误/);
  });

  it("加入成功后保存会话", async () => {
    goto("/join?room=room-1#i=tok-1");
    stubFetchApi([
      {
        url: "/api/rooms/room-1",
        method: "GET",
        body: { roomId: "room-1", exists: true, locked: false, memberCount: 1, maxMembers: 16, needsPassword: false },
      },
      {
        url: "/api/rooms/room-1/sessions",
        method: "POST",
        body: { roomId: "room-1", sessionToken: "sess-2", memberId: "m-2", role: "listener", serverTimeMs: 55 },
      },
    ]);
    render(<JoinPage />);
    fireEvent.change(screen.getByTestId("join-name"), { target: { value: "小明" } });
    fireEvent.click(screen.getByTestId("join-room"));
    await waitFor(() => {
      expect(loadSession("room-1")?.memberId).toBe("m-2");
    });
  });
});

describe("RoomPage 房间页", () => {
  const hostSession = {
    roomId: "room-1",
    sessionToken: "sess-host",
    memberId: "m-host",
    role: "host",
    name: "房主",
    serverTimeMs: 1_000_000,
    localTimeMs: 1_000_000,
    inviteToken: "inv-host",
  };

  function renderHostRoom() {
    goto("/room/room-1");
    saveSession(hostSession);
    stubWebSocket();
    stubFetchApi([
      {
        url: "/api/rooms/room-1",
        method: "GET",
        body: { roomId: "room-1", exists: true, locked: false, memberCount: 2, maxMembers: 16, needsPassword: false },
      },
    ]);
    render(<RoomPage roomId="room-1" />);
    const ws = FakeWebSocket.latest!;
    act(() => ws.simulateOpen());
    return {
      simulateServerMessage: (env: unknown) => act(() => ws.simulateServerMessage(env)),
      close: (code: number, reason: string) => act(() => ws.close(code, reason)),
      sentTypes: () => ws.sentTypes(),
      ws,
    };
  }

  it("无会话时提示从邀请链接重新加入", () => {
    render(<RoomPage roomId="room-none" />);
    expect(screen.getByTestId("session-missing")).toBeInTheDocument();
  });

  it("房主可见邀请链接、控制按钮与成员列表；连接横幅随状态变化", () => {
    const ws = renderHostRoom();
    expect(screen.getByTestId("connection-banner")).toHaveTextContent("已连接");
    ws.simulateServerMessage({
      v: 1, type: "ROOM_SNAPSHOT", eventId: "e", roomRevision: 4, senderId: "relay", sentAtMs: 0,
      payload: {
        roomId: "room-1", revision: 4, playing: false, positionMs: 0,
        currentTrack: { trackId: "k1", title: "Song A", artist: "艺人", durationMs: 180_000 },
        transitionId: null, startAtMs: null, queue: [],
        members: [
          { memberId: "m-host", name: "房主", role: "host", status: "online" },
          { memberId: "m-2", name: "小明", role: "listener", status: "online" },
        ],
      },
    });

    expect(screen.getByTestId("now-playing")).toHaveTextContent(/Song A/);
    expect(screen.getByTestId("member-list")).toHaveTextContent("小明");
    expect(screen.getByTestId("invite-link")).toHaveTextContent("room=room-1");
    expect(screen.getByTestId("play-btn")).toBeInTheDocument();
    expect(screen.getByTestId("lock-toggle")).toHaveTextContent("锁房");
    // 房主不显示“重新同步”入口（那是成员的自助操作）
    expect(screen.queryByTestId("resync-btn")).toBeNull();
  });

  it("屏障期间显示就绪进度；未加载本地音频时房主不上报 READY（Phase 2 门控）", () => {
    const ws = renderHostRoom();
    ws.simulateServerMessage({
      v: 1, type: "ROOM_SNAPSHOT", eventId: "e", roomRevision: 2, senderId: "relay", sentAtMs: 0,
      payload: {
        roomId: "room-1", revision: 2, playing: false, positionMs: 0,
        currentTrack: null, transitionId: null, startAtMs: null, queue: [],
        members: [
          { memberId: "m-host", name: "房主", role: "host", status: "online" },
          { memberId: "m-2", name: "小明", role: "listener", status: "online" },
        ],
      },
    });
    ws.simulateServerMessage({
      v: 1, type: "NEXT_TRACK_PREPARE", eventId: "e", roomRevision: 3, senderId: "m-host", sentAtMs: 0,
      payload: {
        transitionId: "tr-1",
        track: { trackId: "k1", title: "Song B", durationMs: 100 },
        startPositionMs: 0,
        prepareDeadlineMs: 1_005_000,
        startAtMs: 1_008_000,
      },
    });
    expect(screen.getByTestId("barrier-banner")).toHaveTextContent(/准备下一首：《Song B》/);
    expect(screen.getByTestId("barrier-banner")).toHaveTextContent(/0\/2/);
    expect(ws.sentTypes()).not.toContain("READY");
  });

  it("会话失效的致命横幅给出重新加入指引", () => {
    const ws = renderHostRoom();
    ws.close(4001, "session invalid");
    expect(screen.getByTestId("fatal-banner")).toHaveTextContent(/重新加入/);
  });
});

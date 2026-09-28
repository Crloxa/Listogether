import { describe, expect, it } from "vitest";
import { buildInviteLink, parseInviteFromLocation } from "../features/room/invite";
import { clearSession, loadSession, saveSession, serverNowMs, type RoomSession } from "../features/room/session";

describe("invite link", () => {
  it("构造链接：房间 ID 在 query，邀请 token 在 fragment", () => {
    const link = buildInviteLink("http://localhost:5173", "room-1", "tok-123");
    expect(link).toBe("http://localhost:5173/join?room=room-1#i=tok-123");
  });

  it("解析完整链接", () => {
    const ref = parseInviteFromLocation({
      pathname: "/join",
      search: "?room=room-1",
      hash: "#i=tok-123",
    });
    expect(ref).toEqual({ roomId: "room-1", inviteToken: "tok-123" });
  });

  it("缺少 token 时仅返回 roomId", () => {
    const ref = parseInviteFromLocation({ pathname: "/join", search: "?room=room-1", hash: "" });
    expect(ref).toEqual({ roomId: "room-1", inviteToken: null });
  });
});

describe("room session storage", () => {
  const session: RoomSession = {
    roomId: "room-1",
    sessionToken: "tok",
    memberId: "m-1",
    role: "host",
    name: "房主",
    serverTimeMs: 5_000_000,
    localTimeMs: 5_000_000,
    inviteToken: "inv",
  };

  it("保存后可读取，清除后为空", () => {
    saveSession(session);
    expect(loadSession("room-1")?.sessionToken).toBe("tok");
    clearSession("room-1");
    expect(loadSession("room-1")).toBeNull();
  });

  it("损坏的数据返回 null", () => {
    sessionStorage.setItem("listo.session.room-bad", "{not-json");
    expect(loadSession("room-bad")).toBeNull();
  });

  it("serverNowMs 按会话时刻换算服务器时钟", () => {
    saveSession(session);
    const now = serverNowMs(session);
    expect(now).toBeGreaterThanOrEqual(session.serverTimeMs);
  });
});

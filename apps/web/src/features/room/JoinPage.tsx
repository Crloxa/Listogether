/** 加入页：解析邀请链接（?room=xxx#i=token），校验后换取会话并进入房间。 */
import { useEffect, useState } from "react";
import { navigate, useRoute } from "../../app/router";
import { roomApi, describeApiError, type RoomInfoResponse } from "./api";
import { saveSession } from "./session";
import { parseInviteFromLocation } from "./invite";

const friendlyJoinError: Record<string, string> = {
  ROOM_LOCKED: "房间已锁房，暂不接受新成员。请联系房主解锁。",
  ROOM_FULL: "房间人数已满，无法加入。",
  ROOM_NOT_FOUND: "房间不存在或已关闭，请确认邀请链接。",
  INVALID_TOKEN: "邀请链接无效，请向房主要取新的链接。",
  UNAUTHORIZED: "房间密码错误，请重新输入。",
  NETWORK: "无法连接房间服务，请稍后重试。",
};

export default function JoinPage() {
  const route = useRoute();
  const invite = parseInviteFromLocation({
    pathname: route.path,
    search: route.search.toString() ? `?${route.search.toString()}` : window.location.search,
    hash: window.location.hash,
  });
  const roomId = invite.roomId;
  const inviteToken = invite.inviteToken;

  const [info, setInfo] = useState<RoomInfoResponse | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    roomApi
      .info(roomId)
      .then((res) => {
        if (!cancelled) setInfo(res);
      })
      .catch(() => {
        /* 信息获取失败不阻塞加入，错误在提交时体现 */
      });
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  if (!roomId || !inviteToken) {
    return (
      <main className="page">
        <h1>加入房间</h1>
        <p role="alert" data-testid="invite-missing">
          邀请链接不完整：缺少房间或邀请凭证。请使用房主分享的完整链接。
        </p>
        <a href="/">返回首页</a>
      </main>
    );
  }

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await roomApi.join(roomId!, {
        inviteToken: inviteToken!,
        name: name.trim(),
        password: password || undefined,
      });
      saveSession({
        roomId: result.roomId,
        sessionToken: result.sessionToken,
        memberId: result.memberId,
        role: result.role,
        name: name.trim(),
        serverTimeMs: result.serverTimeMs,
        localTimeMs: Date.now(),
      });
      navigate(`/room/${result.roomId}`);
    } catch (err) {
      setError(friendlyJoinError[describeApiErrorCode(err)] ?? describeApiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <h1>加入房间</h1>
      <p>
        房间 <code data-testid="join-room-id">{roomId}</code>
        {info && (
          <span data-testid="join-room-meta">
            （{info.memberCount}/{info.maxMembers} 人
            {info.locked ? " · 已锁房" : ""}
            {info.needsPassword ? " · 需要密码" : ""}）
          </span>
        )}
      </p>
      <form onSubmit={handleJoin} aria-label="加入房间">
        <label>
          你的昵称
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="房内显示的名字"
            required
            maxLength={64}
            data-testid="join-name"
          />
        </label>
        {info?.needsPassword && (
          <label>
            房间密码
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              maxLength={128}
              data-testid="join-password"
            />
          </label>
        )}
        <button type="submit" disabled={busy || name.trim() === ""} data-testid="join-room">
          {busy ? "正在加入…" : "加入房间"}
        </button>
        {error && (
          <p role="alert" data-testid="join-error">
            {error}
          </p>
        )}
      </form>
    </main>
  );
}

function describeApiErrorCode(err: unknown): string {
  return (err as { code?: string })?.code ?? "";
}

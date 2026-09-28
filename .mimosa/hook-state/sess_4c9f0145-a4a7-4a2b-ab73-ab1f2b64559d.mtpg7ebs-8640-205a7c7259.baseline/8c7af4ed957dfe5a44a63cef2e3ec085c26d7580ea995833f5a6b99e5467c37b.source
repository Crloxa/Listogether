/** 首页：创建房间（Phase 1 checklist 第 1 项）。 */
import { useState } from "react";
import { navigate } from "./router";
import { roomApi, describeApiError } from "../features/room/api";
import { saveSession } from "../features/room/session";
import RelayHealth from "./RelayHealth";

export default function HomePage() {
  const [hostName, setHostName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await roomApi.create({ hostName: hostName.trim(), password: password || undefined });
      saveSession({
        roomId: result.roomId,
        sessionToken: result.sessionToken,
        memberId: result.memberId,
        role: result.role,
        name: hostName.trim(),
        serverTimeMs: result.serverTimeMs,
        localTimeMs: Date.now(),
        inviteToken: result.inviteToken,
      });
      navigate(`/room/${result.roomId}`);
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <h1>Listogether</h1>
      <p>朋友的音乐房间 · 创建房间并邀请好友加入</p>
      <RelayHealth />
      <form onSubmit={handleCreate} aria-label="创建房间">
        <label>
          你的昵称
          <input
            value={hostName}
            onChange={(e) => setHostName(e.target.value)}
            placeholder="例如：阿明"
            required
            maxLength={64}
            data-testid="host-name"
          />
        </label>
        <label>
          房间密码（可选，成员加入时需要输入）
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="留空表示无需密码"
            maxLength={128}
            data-testid="room-password"
          />
        </label>
        <button type="submit" disabled={busy || hostName.trim() === ""} data-testid="create-room">
          {busy ? "正在创建…" : "创建房间"}
        </button>
        {error && (
          <p role="alert" data-testid="create-error">
            {error}
          </p>
        )}
      </form>
      <p>
        好友发来了邀请链接？<a href="/join">点这里加入房间</a>。
      </p>
      <p className="hint">房主选择本地音频文件，经 WebRTC 实时分享给房间成员；下一首按统一开始时间对齐（Phase 2）。</p>
    </main>
  );
}

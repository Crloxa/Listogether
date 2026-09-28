/** 房间会话在浏览器端的持久化（sessionStorage，按标签页隔离，
 * 同一浏览器的两个标签页可以作为两个独立成员加入同一房间）。 */

export interface RoomSession {
  roomId: string;
  sessionToken: string;
  memberId: string;
  role: string;
  name: string;
  /** 会话签发时的服务器时间与本地时间（用于服务器时钟换算）。 */
  serverTimeMs: number;
  localTimeMs: number;
  /** 仅房主持有：用于在房间页生成邀请链接（D-007）。 */
  inviteToken?: string;
}

const storageKey = (roomId: string) => `listo.session.${roomId}`;

export function saveSession(session: RoomSession): void {
  sessionStorage.setItem(storageKey(session.roomId), JSON.stringify(session));
}

export function loadSession(roomId: string): RoomSession | null {
  const raw = sessionStorage.getItem(storageKey(roomId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as RoomSession;
    if (!parsed.sessionToken || !parsed.memberId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearSession(roomId: string): void {
  sessionStorage.removeItem(storageKey(roomId));
}

/** 按服务器时钟估计当前时间；屏障 startAtMs/deadline 都应与之比较。 */
export function serverNowMs(session: RoomSession): number {
  return session.serverTimeMs + (Date.now() - session.localTimeMs);
}

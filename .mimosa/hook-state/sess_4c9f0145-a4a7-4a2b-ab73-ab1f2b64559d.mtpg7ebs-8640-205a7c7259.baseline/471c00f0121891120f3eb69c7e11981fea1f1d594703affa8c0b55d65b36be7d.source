/** 邀请链接构造与解析（DECISIONS.md D-007）。
 * 房间 ID 走 query（非敏感），邀请 token 放 fragment，不会进入任何服务器访问日志。 */

export interface InviteRef {
  roomId: string | null;
  inviteToken: string | null;
}

export function buildInviteLink(webOrigin: string, roomId: string, inviteToken: string): string {
  return `${webOrigin}/join?room=${encodeURIComponent(roomId)}#i=${encodeURIComponent(inviteToken)}`;
}

export function parseInviteFromLocation(loc: {
  pathname: string;
  search: string;
  hash: string;
}): InviteRef {
  const search = new URLSearchParams(loc.search);
  const tokenMatch = loc.hash.match(/i=([^&]+)/);
  return {
    roomId: search.get("room"),
    inviteToken: tokenMatch?.[1] ? decodeURIComponent(tokenMatch[1]) : null,
  };
}

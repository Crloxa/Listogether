package hub

import (
	"sync"
	"testing"
	"time"

	"listogether/apps/relay/internal/auth"
	"listogether/apps/relay/internal/protocol"
	"listogether/apps/relay/internal/room"
)

// fakeConn 最小连接实现：权限判定依赖成员记录，测试需先挂载。
type fakeConn struct {
	mu     sync.Mutex
	closed bool
}

func (c *fakeConn) Send(env protocol.Envelope) bool { return true }
func (c *fakeConn) Close(code int, reason string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
}

var _ room.Conn = (*fakeConn)(nil)

func attachMember(t *testing.T, r *room.Room, id room.Identity) {
	t.Helper()
	if res := r.Attach(&fakeConn{}, id); res.Err != nil {
		t.Fatalf("attach %s: %v", id.MemberID, res.Err)
	}
}

func newTestHub(t *testing.T, sessionTTL time.Duration) *Hub {
	t.Helper()
	// 清理周期足够长，由测试显式调用 Sweep
	h := NewWithTuning(nil, sessionTTL, sessionTTL, time.Hour)
	t.Cleanup(h.Close)
	return h
}

func createRoom(t *testing.T, h *Hub, opts CreateOptions) CreateResult {
	t.Helper()
	result, err := h.CreateRoom(opts)
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}
	return result
}

func TestCreateRoomIssuesUniqueCredentials(t *testing.T) {
	h := newTestHub(t, DefaultSessionTTL)
	r1 := createRoom(t, h, CreateOptions{HostName: "房主A"})
	r2 := createRoom(t, h, CreateOptions{HostName: "房主B"})
	if r1.RoomID == r2.RoomID || r1.InviteToken == r2.InviteToken || r1.SessionToken == r2.SessionToken {
		t.Fatal("房间 ID / 邀请 token / 会话 token 必须唯一")
	}
	if r1.Role != room.RoleHost || r1.MaxMembers != DefaultMaxMembersRoom {
		t.Fatalf("unexpected create result: %+v", r1)
	}
	if r1.PasswordSet {
		t.Fatal("未设密码时 PasswordSet 应为 false")
	}
	if _, ok := h.LookupSession(r1.SessionToken); !ok {
		t.Fatal("房主会话应可查到")
	}
}

func TestCreateRoomValidatesAndClamps(t *testing.T) {
	h := newTestHub(t, DefaultSessionTTL)
	if _, err := h.CreateRoom(CreateOptions{HostName: ""}); err == nil || err.Code != protocol.CodeInvalidMessage {
		t.Fatalf("空昵称应拒绝: %v", err)
	}
	r := createRoom(t, h, CreateOptions{HostName: "A", MaxMembers: 9999, Password: "pw"})
	if r.MaxMembers != roomMaxMembersCap {
		t.Fatalf("MaxMembers 应钳制为 %d, got %d", roomMaxMembersCap, r.MaxMembers)
	}
	if !r.PasswordSet {
		t.Fatal("设置密码后 PasswordSet 应为 true")
	}
}

func TestJoinValidations(t *testing.T) {
	h := newTestHub(t, DefaultSessionTTL)
	created := createRoom(t, h, CreateOptions{HostName: "房主", Password: "secret", MaxMembers: 2})
	// 挂载房主连接后成员计数生效
	attachMember(t, mustRoom(t, h, created.RoomID), room.Identity{MemberID: created.MemberID, Name: "房主", Role: room.RoleHost})

	if _, err := h.Join("no-such-room", JoinOptions{InviteToken: created.InviteToken, Name: "B"}); err == nil || err.Code != protocol.CodeRoomNotFound {
		t.Fatalf("未知房间应 ROOM_NOT_FOUND, got %v", err)
	}
	if _, err := h.Join(created.RoomID, JoinOptions{InviteToken: "wrong", Name: "B"}); err == nil || err.Code != protocol.CodeInvalidToken {
		t.Fatalf("错误邀请 token 应 INVALID_TOKEN, got %v", err)
	}
	if _, err := h.Join(created.RoomID, JoinOptions{InviteToken: created.InviteToken, Name: "B", Password: "bad"}); err == nil || err.Code != protocol.CodeUnauthorized {
		t.Fatalf("错误密码应 UNAUTHORIZED, got %v", err)
	}
	joined, err := h.Join(created.RoomID, JoinOptions{InviteToken: created.InviteToken, Name: "B", Password: "secret"})
	if err != nil {
		t.Fatalf("正确密码应通过: %v", err)
	}
	attachMember(t, mustRoom(t, h, created.RoomID), room.Identity{MemberID: joined.MemberID, Name: "B", Role: room.RoleListener})
	// 满员（房主 + 1 成员 = 上限 2）
	if _, err := h.Join(created.RoomID, JoinOptions{InviteToken: created.InviteToken, Name: "C", Password: "secret"}); err == nil || err.Code != protocol.CodeRoomFull {
		t.Fatalf("满员应 ROOM_FULL, got %v", err)
	}
}

func TestJoinLockedRoomRejected(t *testing.T) {
	h := newTestHub(t, DefaultSessionTTL)
	created := createRoom(t, h, CreateOptions{HostName: "房主"})
	r := mustRoom(t, h, created.RoomID)
	attachMember(t, r, room.Identity{MemberID: created.MemberID, Name: "房主", Role: room.RoleHost})
	if err := r.LockRoom(created.MemberID, true); err != nil {
		t.Fatalf("LockRoom: %v", err)
	}
	if _, err := h.Join(created.RoomID, JoinOptions{InviteToken: created.InviteToken, Name: "B"}); err == nil || err.Code != protocol.CodeRoomLocked {
		t.Fatalf("锁房后加入应 ROOM_LOCKED, got %v", err)
	}
	info, err := h.RoomInfo(created.RoomID)
	if err != nil || !info.Locked || !info.Exists {
		t.Fatalf("RoomInfo 应显示锁定: %+v err=%v", info, err)
	}
}

func TestSessionLookupForRoomAndInvalidation(t *testing.T) {
	h := newTestHub(t, DefaultSessionTTL)
	created := createRoom(t, h, CreateOptions{HostName: "房主"})
	joined, jerr := h.Join(created.RoomID, JoinOptions{InviteToken: created.InviteToken, Name: "B"})
	if jerr != nil {
		t.Fatalf("Join: %v", jerr)
	}
	if _, ok := h.LookupSessionForRoom(created.RoomID, joined.SessionToken); !ok {
		t.Fatal("成员会话应有效")
	}
	if _, ok := h.LookupSessionForRoom("other-room", joined.SessionToken); ok {
		t.Fatal("房间不匹配的会话应无效")
	}
	// 成员被移除后会话失效（双方均已挂载，权限判定生效）
	r := mustRoom(t, h, created.RoomID)
	attachMember(t, r, room.Identity{MemberID: created.MemberID, Name: "房主", Role: room.RoleHost})
	attachMember(t, r, room.Identity{MemberID: joined.MemberID, Name: "B", Role: room.RoleListener})
	if err := r.Kick(created.MemberID, joined.MemberID); err != nil {
		t.Fatalf("Kick: %v", err)
	}
	if _, ok := h.LookupSession(joined.SessionToken); ok {
		t.Fatal("被踢成员会话应失效")
	}
}

func TestCloseRoomInvalidatesAllSessions(t *testing.T) {
	h := newTestHub(t, DefaultSessionTTL)
	created := createRoom(t, h, CreateOptions{HostName: "房主"})
	joined, _ := h.Join(created.RoomID, JoinOptions{InviteToken: created.InviteToken, Name: "B"})
	r := mustRoom(t, h, created.RoomID)
	attachMember(t, r, room.Identity{MemberID: created.MemberID, Name: "房主", Role: room.RoleHost})
	if err := r.CloseRoomByHost(created.MemberID); err != nil {
		t.Fatalf("CloseRoomByHost: %v", err)
	}
	if _, ok := h.Room(created.RoomID); ok {
		t.Fatal("关闭后房间应被移除")
	}
	if _, ok := h.LookupSession(created.SessionToken); ok {
		t.Fatal("关闭后房主会话应失效")
	}
	if _, ok := h.LookupSession(joined.SessionToken); ok {
		t.Fatal("关闭后成员会话应失效")
	}
}

func mustRoom(t *testing.T, h *Hub, roomID string) *room.Room {
	t.Helper()
	r, ok := h.Room(roomID)
	if !ok {
		t.Fatalf("房间 %s 应存在", roomID)
	}
	return r
}

func TestSweepRemovesExpiredSessionsAndUnusedRooms(t *testing.T) {
	ttl := 50 * time.Millisecond
	h := newTestHub(t, ttl)
	created := createRoom(t, h, CreateOptions{HostName: "房主"}) // 从未挂载连接
	joined, _ := h.Join(created.RoomID, JoinOptions{InviteToken: created.InviteToken, Name: "B"})
	h.Sweep(time.Now().Add(ttl + 100*time.Millisecond))
	if _, ok := h.LookupSession(created.SessionToken); ok {
		t.Fatal("过期会话应被清理")
	}
	if _, ok := h.LookupSession(joined.SessionToken); ok {
		t.Fatal("过期会话应被清理")
	}
	if _, ok := h.Room(created.RoomID); ok {
		t.Fatal("从未挂载的过期房间应被清理")
	}
}

func TestInviteTokenStoredOnlyAsHash(t *testing.T) {
	h := newTestHub(t, DefaultSessionTTL)
	created := createRoom(t, h, CreateOptions{HostName: "房主"})
	r, _ := h.Room(created.RoomID)
	if r.InviteTokenHash() == created.InviteToken {
		t.Fatal("房间不得保存邀请 token 原文")
	}
	if !auth.EqualTokens(auth.HashToken(created.InviteToken), r.InviteTokenHash()) {
		t.Fatal("保存的哈希应与 token 原文哈希一致")
	}
}

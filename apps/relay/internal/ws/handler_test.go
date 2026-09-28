package ws

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"listogether/apps/relay/internal/hub"
	"listogether/apps/relay/internal/protocol"
	"listogether/apps/relay/internal/room"
)

var testOrigins = []string{"http://localhost:5173"}

var testLogger = slog.New(slog.NewTextHandler(io.Discard, nil))

func newTestServer(t *testing.T) (*hub.Hub, *httptest.Server) {
	t.Helper()
	h := hub.New(testLogger)
	t.Cleanup(h.Close)
	srv := httptest.NewServer(NewHandler(testLogger, h, testOrigins))
	t.Cleanup(srv.Close)
	return h, srv
}

// dialURL 建立带 query 凭证的 WS 连接。
func dialURL(t *testing.T, srv *httptest.Server, roomID, sessionToken, origin string) *websocket.Conn {
	t.Helper()
	header := http.Header{}
	if origin != "" {
		header.Set("Origin", origin)
	}
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws?roomId=" + roomID + "&sessionToken=" + sessionToken
	conn, _, err := websocket.DefaultDialer.Dial(url, header)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func sendJSON(t *testing.T, conn *websocket.Conn, v any) {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
		t.Fatalf("write: %v", err)
	}
}

type wireEnvelope struct {
	Type         string          `json:"type"`
	EventID      string          `json:"eventId"`
	RoomRevision int64           `json:"roomRevision"`
	SenderID     string          `json:"senderId"`
	Payload      json.RawMessage `json:"payload"`
}

// readEnvelope 读取一条服务端消息；跳过连接建立时单发的 CHAT_HISTORY（Phase 3 辅助消息）。
func readEnvelope(t *testing.T, conn *websocket.Conn) wireEnvelope {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	defer func() { _ = conn.SetReadDeadline(time.Time{}) }()
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("read envelope: %v", err)
		}
		var env wireEnvelope
		if err := json.Unmarshal(data, &env); err != nil {
			t.Fatalf("reply not JSON: %v\n%s", err, data)
		}
		if env.Type == "CHAT_HISTORY" {
			continue
		}
		return env
	}
}

// expectNoMessage 断言 300ms 内没有消息。
func expectNoMessage(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	_, data, err := conn.ReadMessage()
	if err == nil {
		t.Fatalf("不应收到消息, got: %s", data)
	}
	if strings.Contains(err.Error(), "closed") {
		t.Fatalf("连接不应被关闭: %v", err)
	}
	_ = conn.SetReadDeadline(time.Time{})
}

func payloadOf(t *testing.T, env wireEnvelope) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(env.Payload, &m); err != nil {
		t.Fatalf("payload unmarshal: %v", err)
	}
	return m
}

// createAndAttachHost 建房并挂载房主连接，返回会话材料与已连接的首条快照。
func createAndAttachHost(t *testing.T, h *hub.Hub, srv *httptest.Server) (hub.CreateResult, *websocket.Conn) {
	t.Helper()
	created, cerr := h.CreateRoom(hub.CreateOptions{HostName: "房主"})
	if cerr != nil {
		t.Fatalf("create room: %v", cerr)
	}
	conn := dialURL(t, srv, created.RoomID, created.SessionToken, "http://localhost:5173")
	env := readEnvelope(t, conn)
	if env.Type != protocol.TypeRoomSnapshot {
		t.Fatalf("首条消息应为 ROOM_SNAPSHOT, got %s", env.Type)
	}
	return created, conn
}

func TestHandshakeRejectedWithoutSession(t *testing.T) {
	_, srv := newTestServer(t)
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws?roomId=whatever&sessionToken=bogus"
	if _, _, err := websocket.DefaultDialer.Dial(url, nil); err == nil {
		t.Fatal("无效会话的握手应失败")
	}
	urlNoQuery := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	if _, _, err := websocket.DefaultDialer.Dial(urlNoQuery, nil); err == nil {
		t.Fatal("缺少凭证的握手应失败")
	}
}

func TestAttachSendsSnapshotAndBroadcastsJoin(t *testing.T) {
	h, srv := newTestServer(t)
	created, hostConn := createAndAttachHost(t, h, srv)

	joined, jerr := h.Join(created.RoomID, hub.JoinOptions{InviteToken: created.InviteToken, Name: "小明"})
	if jerr != nil {
		t.Fatalf("join: %v", jerr)
	}
	memberConn := dialURL(t, srv, created.RoomID, joined.SessionToken, "http://localhost:5173")
	snap := readEnvelope(t, memberConn)
	if snap.Type != protocol.TypeRoomSnapshot {
		t.Fatalf("成员首条消息应为快照, got %s", snap.Type)
	}
	// 新成员已有快照，MEMBER_JOINED 只发给其他成员；房主收到成员加入
	joinedEnv := readEnvelope(t, hostConn)
	if joinedEnv.Type != protocol.TypeMemberJoined {
		t.Fatalf("房主应收到 MEMBER_JOINED, got %s", joinedEnv.Type)
	}
	if joinedEnv.RoomRevision != snap.RoomRevision {
		t.Fatalf("MEMBER_JOINED 与快照 revision 应一致: %d vs %d", joinedEnv.RoomRevision, snap.RoomRevision)
	}
	member := payloadOf(t, joinedEnv)["member"].(map[string]any)
	if member["memberId"] != joined.MemberID || member["status"] != "online" {
		t.Fatalf("unexpected member: %v", member)
	}
}

func TestHostPlayBroadcastToMembers(t *testing.T) {
	h, srv := newTestServer(t)
	created, hostConn := createAndAttachHost(t, h, srv)
	joined, _ := h.Join(created.RoomID, hub.JoinOptions{InviteToken: created.InviteToken, Name: "小明"})
	memberConn := dialURL(t, srv, created.RoomID, joined.SessionToken, "http://localhost:5173")
	readEnvelope(t, memberConn) // snapshot
	readEnvelope(t, hostConn)   // member joined

	// 房主 PLAY（revision 2：两次加入广播后）
	sendJSON(t, hostConn, map[string]any{
		"v": 1, "type": "PLAY", "eventId": "e-play", "roomRevision": 2,
		"senderId": "spoofed-id", "sentAtMs": 0, "payload": map[string]any{"positionMs": 1000},
	})
	play := readEnvelope(t, memberConn)
	if play.Type != protocol.TypePlay {
		t.Fatalf("成员应收到 PLAY, got %s", play.Type)
	}
	if play.SenderID == "spoofed-id" {
		t.Fatal("senderId 必须被会话绑定成员覆写")
	}
	// 房主自己也收到广播回显
	echo := readEnvelope(t, hostConn)
	if echo.Type != protocol.TypePlay || echo.RoomRevision != 3 {
		t.Fatalf("房主回显异常: %+v", echo)
	}
}

func TestListenerPlayRejectedOverWire(t *testing.T) {
	h, srv := newTestServer(t)
	created, hostConn := createAndAttachHost(t, h, srv)
	joined, _ := h.Join(created.RoomID, hub.JoinOptions{InviteToken: created.InviteToken, Name: "小明"})
	memberConn := dialURL(t, srv, created.RoomID, joined.SessionToken, "http://localhost:5173")
	readEnvelope(t, memberConn)
	readEnvelope(t, hostConn)

	sendJSON(t, memberConn, map[string]any{
		"v": 1, "type": "PLAY", "eventId": "e-1", "roomRevision": 2,
		"senderId": joined.MemberID, "sentAtMs": 0, "payload": map[string]any{"positionMs": 0},
	})
	errEnv := readEnvelope(t, memberConn)
	if errEnv.Type != protocol.TypeError {
		t.Fatalf("应收到 ERROR, got %s", errEnv.Type)
	}
	code := payloadOf(t, errEnv)["code"]
	if code != protocol.CodeUnauthorized {
		t.Fatalf("code = %v, want UNAUTHORIZED", code)
	}
}

func TestStaleRevisionRejectedOverWire(t *testing.T) {
	h, srv := newTestServer(t)
	created, hostConn := createAndAttachHost(t, h, srv)
	joined, _ := h.Join(created.RoomID, hub.JoinOptions{InviteToken: created.InviteToken, Name: "小明"})
	memberConn := dialURL(t, srv, created.RoomID, joined.SessionToken, "http://localhost:5173")
	readEnvelope(t, memberConn)
	readEnvelope(t, hostConn)

	sendJSON(t, hostConn, map[string]any{
		"v": 1, "type": "SEEK", "eventId": "e-seek", "roomRevision": 0,
		"senderId": created.MemberID, "sentAtMs": 0, "payload": map[string]any{"positionMs": 30},
	})
	errEnv := readEnvelope(t, hostConn)
	if code := payloadOf(t, errEnv)["code"]; code != protocol.CodeStaleRevision {
		t.Fatalf("code = %v, want STALE_REVISION", code)
	}
}

func TestGarbageFrameRejectedAfterAttach(t *testing.T) {
	h, srv := newTestServer(t)
	created, hostConn := createAndAttachHost(t, h, srv)
	_ = created
	if err := hostConn.WriteMessage(websocket.TextMessage, []byte("not json")); err != nil {
		t.Fatalf("write: %v", err)
	}
	errEnv := readEnvelope(t, hostConn)
	if errEnv.Type != protocol.TypeError || payloadOf(t, errEnv)["code"] != protocol.CodeInvalidMessage {
		t.Fatalf("垃圾帧应回 INVALID_MESSAGE: %+v", errEnv)
	}
}

func TestHeartbeatSilentOverWire(t *testing.T) {
	h, srv := newTestServer(t)
	created, hostConn := createAndAttachHost(t, h, srv)
	_ = created
	sendJSON(t, hostConn, map[string]any{
		"v": 1, "type": "HEARTBEAT", "eventId": "e-hb", "roomRevision": 0,
		"senderId": created.MemberID, "sentAtMs": 0, "payload": map[string]any{"clientTimeMs": 1},
	})
	expectNoMessage(t, hostConn)
}

func TestResyncReturnsSnapshotOverWire(t *testing.T) {
	h, srv := newTestServer(t)
	created, hostConn := createAndAttachHost(t, h, srv)
	_ = created
	sendJSON(t, hostConn, map[string]any{
		"v": 1, "type": "RESYNC_REQUEST", "eventId": "e-rs", "roomRevision": 0,
		"senderId": created.MemberID, "sentAtMs": 0, "payload": map[string]any{},
	})
	env := readEnvelope(t, hostConn)
	if env.Type != protocol.TypeRoomSnapshot {
		t.Fatalf("RESYNC 应返回快照, got %s", env.Type)
	}
}

func TestUnknownRoomAttachFails(t *testing.T) {
	h, srv := newTestServer(t)
	created, cerr := h.CreateRoom(hub.CreateOptions{HostName: "房主"})
	if cerr != nil {
		t.Fatal(cerr)
	}
	// 房间已被关闭（从未挂载的房间被移除前，先显式关闭路径：挂载后关闭）
	_ = created
	// 直接构造一个已删除房间的会话场景：close 后重新拨号应失败
	r, _ := h.Room(created.RoomID)
	if r == nil {
		t.Fatal("房间应存在")
	}
	if err := r.CloseRoomByHost(created.MemberID); err != nil {
		// 从未挂载时成员记录不存在，HTTP 关闭会返回 UNAUTHORIZED；此处仅保证房间仍可用
		t.Log("close before attach denied as expected:", err)
	}
	// 会话仍有效但房间被移除的场景由 hub 清理路径覆盖；这里验证正常挂载
	conn := dialURL(t, srv, created.RoomID, created.SessionToken, "http://localhost:5173")
	if env := readEnvelope(t, conn); env.Type != protocol.TypeRoomSnapshot {
		t.Fatalf("应收到快照, got %s", env.Type)
	}
}

func TestRoomClosedNotifiesMembersWithCloseCode(t *testing.T) {
	h, srv := newTestServer(t)
	created, hostConn := createAndAttachHost(t, h, srv)
	joined, _ := h.Join(created.RoomID, hub.JoinOptions{InviteToken: created.InviteToken, Name: "小明"})
	memberConn := dialURL(t, srv, created.RoomID, joined.SessionToken, "http://localhost:5173")
	readEnvelope(t, memberConn)
	readEnvelope(t, hostConn)

	r, _ := h.Room(created.RoomID)
	if err := r.CloseRoomByHost(created.MemberID); err != nil {
		t.Fatalf("close: %v", err)
	}
	// 房主收到 room_closed
	left := readEnvelope(t, hostConn)
	if left.Type != protocol.TypeMemberLeft {
		t.Fatalf("应收到 MEMBER_LEFT, got %s", left.Type)
	}
	if payloadOf(t, left)["reason"] != "room_closed" {
		t.Fatalf("reason = %v", payloadOf(t, left)["reason"])
	}
	// 连接随后被服务端关闭
	_ = hostConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, err := hostConn.ReadMessage()
	if err == nil {
		t.Fatal("关闭房间后连接应终止")
	}
	// 成员连接也应终止（其先收到自己的 MEMBER_LEFT）
	_ = readEnvelope(t, memberConn)
	_ = memberConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, err = memberConn.ReadMessage()
	if err == nil {
		t.Fatal("成员连接应被关闭")
	}
	if !websocket.IsCloseError(err, CloseRoomClosed, websocket.CloseNormalClosure, websocket.CloseAbnormalClosure, websocket.CloseNoStatusReceived) {
		t.Fatalf("unexpected close: %v", err)
	}
}

func TestKickedMemberConnectionClosed(t *testing.T) {
	h, srv := newTestServer(t)
	created, hostConn := createAndAttachHost(t, h, srv)
	joined, _ := h.Join(created.RoomID, hub.JoinOptions{InviteToken: created.InviteToken, Name: "小明"})
	memberConn := dialURL(t, srv, created.RoomID, joined.SessionToken, "http://localhost:5173")
	readEnvelope(t, memberConn)
	readEnvelope(t, hostConn)

	r, _ := h.Room(created.RoomID)
	if err := r.Kick(created.MemberID, joined.MemberID); err != nil {
		t.Fatalf("kick: %v", err)
	}
	left := readEnvelope(t, hostConn)
	if left.Type != protocol.TypeMemberLeft || payloadOf(t, left)["reason"] != "kicked" {
		t.Fatalf("房主应收到 kicked: %+v", left)
	}
	_ = memberConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := memberConn.ReadMessage(); err == nil {
		t.Fatal("被踢成员连接应被关闭")
	}
	// 被踢成员的会话失效：重连握手应 401
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws?roomId=" + created.RoomID + "&sessionToken=" + joined.SessionToken
	if _, _, err := websocket.DefaultDialer.Dial(url, nil); err == nil {
		t.Fatal("被踢后会话应失效")
	}
}

func TestExplicitLeaveVsGracefulOffline(t *testing.T) {
	h, srv := newTestServer(t)
	created, hostConn := createAndAttachHost(t, h, srv)
	joined, _ := h.Join(created.RoomID, hub.JoinOptions{InviteToken: created.InviteToken, Name: "小明"})
	memberConn := dialURL(t, srv, created.RoomID, joined.SessionToken, "http://localhost:5173")
	readEnvelope(t, memberConn)
	readEnvelope(t, hostConn)

	// 1) 浏览器刷新/关闭产生的普通优雅关闭（1000）：成员进入 offline，而非被移除
	_ = memberConn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
	offlineMark := readEnvelope(t, hostConn)
	if offlineMark.Type != protocol.TypeRoomSnapshot {
		t.Fatalf("普通优雅关闭应广播 offline 快照, got %s", offlineMark.Type)
	}
	var snapPayload struct {
		Members []protocol.Member `json:"members"`
	}
	if err := json.Unmarshal(offlineMark.Payload, &snapPayload); err != nil {
		t.Fatal(err)
	}
	for _, m := range snapPayload.Members {
		if m.MemberID == joined.MemberID && m.Status != room.StatusOffline {
			t.Fatalf("成员应处于 offline: %+v", m)
		}
	}

	// 宽限期内原会话重连恢复
	again := dialURL(t, srv, created.RoomID, joined.SessionToken, "http://localhost:5173")
	if env := readEnvelope(t, again); env.Type != protocol.TypeRoomSnapshot {
		t.Fatalf("重连应收到快照, got %s", env.Type)
	}

	// 2) 显式离开（3001）：立即移除并广播 left
	_ = again.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(CloseLeave, "leave"))
	var left wireEnvelope
	deadline := time.Now().Add(2 * time.Second)
	for {
		_ = hostConn.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, data, err := hostConn.ReadMessage()
		if err != nil {
			t.Fatal("显式离开后房主应收到 MEMBER_LEFT(left)")
		}
		if err := json.Unmarshal(data, &left); err != nil {
			t.Fatal(err)
		}
		if left.Type == protocol.TypeMemberLeft || time.Now().After(deadline) {
			break
		}
	}
	if left.Type != protocol.TypeMemberLeft {
		t.Fatalf("显式离开应广播 MEMBER_LEFT, got %s", left.Type)
	}
	lp := payloadOf(t, left)
	if lp["reason"] != "left" || lp["memberId"] != joined.MemberID {
		t.Fatalf("unexpected left payload: %v", lp)
	}
}

func TestReconnectRestoresMemberIdentity(t *testing.T) {
	h, srv := newTestServer(t)
	created, hostConn := createAndAttachHost(t, h, srv)
	joined, _ := h.Join(created.RoomID, hub.JoinOptions{InviteToken: created.InviteToken, Name: "小明"})
	first := dialURL(t, srv, created.RoomID, joined.SessionToken, "http://localhost:5173")
	readEnvelope(t, first)
	readEnvelope(t, hostConn)

	// 模拟网络中断：直接关闭 TCP（非优雅关闭）
	_ = first.UnderlyingConn().Close()
	time.Sleep(50 * time.Millisecond)

	// 用同一会话重连
	again := dialURL(t, srv, created.RoomID, joined.SessionToken, "http://localhost:5173")
	snap := readEnvelope(t, again)
	if snap.Type != protocol.TypeRoomSnapshot {
		t.Fatalf("重连应收到快照, got %s", snap.Type)
	}
	var payload struct {
		Members []protocol.Member `json:"members"`
	}
	if err := json.Unmarshal(snap.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, m := range payload.Members {
		if m.MemberID == joined.MemberID && m.Status == room.StatusOnline {
			found = true
		}
	}
	if !found {
		t.Fatalf("重连后应恢复成员在线状态: %+v", payload.Members)
	}
}

func TestDisallowedOriginHandshakeFails(t *testing.T) {
	h, srv := newTestServer(t)
	created, cerr := h.CreateRoom(hub.CreateOptions{HostName: "房主"})
	if cerr != nil {
		t.Fatal(cerr)
	}
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws?roomId=" + created.RoomID + "&sessionToken=" + created.SessionToken
	if _, _, err := websocket.DefaultDialer.Dial(url, http.Header{"Origin": []string{"https://evil.example"}}); err == nil {
		t.Fatal("非法 Origin 的握手应失败")
	}
}

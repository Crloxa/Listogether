package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"listogether/apps/relay/internal/hub"
	"listogether/apps/relay/internal/protocol"
	"listogether/apps/relay/internal/room"
)

var testLogger = slog.New(slog.NewTextHandler(io.Discard, nil))

// fakeConn 让测试把会话身份挂载为房间成员记录（权限判定来源）。
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

func attachHost(t *testing.T, h *hub.Hub, created map[string]any) {
	t.Helper()
	attachMember(t, h, created["roomId"].(string), created["memberId"].(string), room.RoleHost)
}

func attachMember(t *testing.T, h *hub.Hub, roomID, memberID, role string) {
	t.Helper()
	r, ok := h.Room(roomID)
	if !ok {
		t.Fatal("房间应存在")
	}
	if res := r.Attach(&fakeConn{}, room.Identity{MemberID: memberID, Name: "成员-" + memberID[:6], Role: role}); res.Err != nil {
		t.Fatalf("attach %s: %v", memberID, res.Err)
	}
}

func newTestAPI(t *testing.T) (*hub.Hub, *httptest.Server) {
	t.Helper()
	h := hub.New(testLogger)
	t.Cleanup(h.Close)
	srv := httptest.NewServer(NewRoomAPI(testLogger, h, []string{"http://localhost:5173"}))
	t.Cleanup(srv.Close)
	return h, srv
}

func postJSON(t *testing.T, url string, body any, headers map[string]string) (int, map[string]any) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer res.Body.Close()
	out := map[string]any{}
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func getJSON(t *testing.T, url string) (int, map[string]any) {
	t.Helper()
	res, err := http.Get(url)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer res.Body.Close()
	out := map[string]any{}
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func num(t *testing.T, v any) float64 {
	t.Helper()
	f, ok := v.(float64)
	if !ok {
		t.Fatalf("期望数字, got %#v", v)
	}
	return f
}

func TestCreateRoomEndpoint(t *testing.T) {
	_, srv := newTestAPI(t)
	status, body := postJSON(t, srv.URL+"/api/rooms", map[string]any{
		"hostName": "房主", "maxMembers": 8,
	}, nil)
	if status != http.StatusCreated {
		t.Fatalf("status = %d body=%v", status, body)
	}
	for _, key := range []string{"roomId", "inviteToken", "sessionToken", "memberId", "role", "serverTimeMs"} {
		if _, ok := body[key]; !ok {
			t.Fatalf("响应缺少 %s: %v", key, body)
		}
	}
	if body["role"] != "host" {
		t.Fatalf("role = %v, want host", body["role"])
	}
}

func TestCreateRoomValidation(t *testing.T) {
	_, srv := newTestAPI(t)
	status, _ := postJSON(t, srv.URL+"/api/rooms", map[string]any{"hostName": ""}, nil)
	if status != http.StatusBadRequest {
		t.Fatalf("空昵称 status = %d, want 400", status)
	}
	status, _ = postJSON(t, srv.URL+"/api/rooms", map[string]any{"hostName": "A", "sneaky": 1}, nil)
	if status != http.StatusBadRequest {
		t.Fatalf("未知字段 status = %d, want 400", status)
	}
}

func TestJoinEndpointErrorsAndSuccess(t *testing.T) {
	_, srv := newTestAPI(t)
	_, created := postJSON(t, srv.URL+"/api/rooms", map[string]any{"hostName": "房主"}, nil)
	roomID := created["roomId"].(string)
	invite := created["inviteToken"].(string)

	status, body := postJSON(t, srv.URL+"/api/rooms/"+roomID+"/sessions", map[string]any{"inviteToken": "bad", "name": "B"}, nil)
	if status != http.StatusUnauthorized || body["code"] != "INVALID_TOKEN" {
		t.Fatalf("错误邀请 token: status=%d body=%v", status, body)
	}
	status, body = postJSON(t, srv.URL+"/api/rooms/"+roomID+"/sessions", map[string]any{"inviteToken": invite, "name": "B"}, nil)
	if status != http.StatusCreated {
		t.Fatalf("正常加入: status=%d body=%v", status, body)
	}
	if body["role"] != "listener" {
		t.Fatalf("role = %v, want listener", body["role"])
	}
}

func TestRoomInfoEndpoint(t *testing.T) {
	_, srv := newTestAPI(t)
	_, created := postJSON(t, srv.URL+"/api/rooms", map[string]any{"hostName": "房主", "password": "pw", "maxMembers": 5}, nil)
	roomID := created["roomId"].(string)

	status, info := getJSON(t, srv.URL+"/api/rooms/"+roomID)
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if info["needsPassword"] != true || info["exists"] != true {
		t.Fatalf("info = %v", info)
	}
	if num(t, info["maxMembers"]) != 5 {
		t.Fatalf("maxMembers = %v, want 5", info["maxMembers"])
	}
	status, _ = getJSON(t, srv.URL+"/api/rooms/missing-room")
	if status != http.StatusNotFound {
		t.Fatalf("缺失房间 status = %d, want 404", status)
	}
}

func TestLockRequiresHostRole(t *testing.T) {
	h, srv := newTestAPI(t)
	_, created := postJSON(t, srv.URL+"/api/rooms", map[string]any{"hostName": "房主"}, nil)
	roomID := created["roomId"].(string)
	hostSession := created["sessionToken"].(string)
	attachHost(t, h, created)
	_, joined := postJSON(t, srv.URL+"/api/rooms/"+roomID+"/sessions", map[string]any{"inviteToken": created["inviteToken"], "name": "B"}, nil)
	listenerSession := joined["sessionToken"].(string)
	auth := map[string]string{"Authorization": "Bearer " + listenerSession}

	// 无凭证 → 401
	status, body := postJSON(t, srv.URL+"/api/rooms/"+roomID+"/lock", map[string]any{"locked": true}, nil)
	if status != http.StatusUnauthorized || body["code"] != "INVALID_TOKEN" {
		t.Fatalf("无凭证: status=%d body=%v", status, body)
	}
	// listener → 403
	status, body = postJSON(t, srv.URL+"/api/rooms/"+roomID+"/lock", map[string]any{"locked": true}, auth)
	if status != http.StatusForbidden || body["code"] != "UNAUTHORIZED" {
		t.Fatalf("listener 锁房: status=%d body=%v", status, body)
	}
	// 房主 → 200
	hostAuth := map[string]string{"Authorization": "Bearer " + hostSession}
	status, _ = postJSON(t, srv.URL+"/api/rooms/"+roomID+"/lock", map[string]any{"locked": true}, hostAuth)
	if status != http.StatusOK {
		t.Fatalf("房主锁房 status = %d", status)
	}
	// 锁房后加入被拒 → 403
	status, body = postJSON(t, srv.URL+"/api/rooms/"+roomID+"/sessions", map[string]any{"inviteToken": created["inviteToken"], "name": "C"}, nil)
	if status != http.StatusForbidden || body["code"] != "ROOM_LOCKED" {
		t.Fatalf("锁房后加入: status=%d body=%v", status, body)
	}
}

func TestKickAndRoleEndpoints(t *testing.T) {
	h, srv := newTestAPI(t)
	_, created := postJSON(t, srv.URL+"/api/rooms", map[string]any{"hostName": "房主"}, nil)
	roomID := created["roomId"].(string)
	hostAuth := map[string]string{"Authorization": "Bearer " + created["sessionToken"].(string)}
	attachHost(t, h, created)
	_, joined := postJSON(t, srv.URL+"/api/rooms/"+roomID+"/sessions", map[string]any{"inviteToken": created["inviteToken"], "name": "B"}, nil)
	memberID := joined["memberId"].(string)
	attachMember(t, h, roomID, memberID, room.RoleListener)

	// 房主授权共同 DJ
	status, _ := postJSON(t, srv.URL+"/api/rooms/"+roomID+"/members/"+memberID+"/role", map[string]any{"role": "co_dj"}, hostAuth)
	if status != http.StatusOK {
		t.Fatalf("授权角色 status = %d", status)
	}
	// 非法角色 → 400
	status, _ = postJSON(t, srv.URL+"/api/rooms/"+roomID+"/members/"+memberID+"/role", map[string]any{"role": "host"}, hostAuth)
	if status != http.StatusBadRequest {
		t.Fatalf("指定 host 角色 status = %d, want 400", status)
	}
	// 房主踢人 → 200
	status, _ = postJSON(t, srv.URL+"/api/rooms/"+roomID+"/members/"+memberID+"/kick", nil, hostAuth)
	if status != http.StatusOK {
		t.Fatalf("踢人 status = %d", status)
	}
	// 再踢已移除成员 → 404
	status, body := postJSON(t, srv.URL+"/api/rooms/"+roomID+"/members/"+memberID+"/kick", nil, hostAuth)
	if status != http.StatusNotFound {
		t.Fatalf("重复踢人 status=%d body=%v", status, body)
	}
}

func TestCloseEndpoint(t *testing.T) {
	h, srv := newTestAPI(t)
	_, created := postJSON(t, srv.URL+"/api/rooms", map[string]any{"hostName": "房主"}, nil)
	roomID := created["roomId"].(string)
	hostAuth := map[string]string{"Authorization": "Bearer " + created["sessionToken"].(string)}
	attachHost(t, h, created)
	status, _ := postJSON(t, srv.URL+"/api/rooms/"+roomID+"/close", nil, hostAuth)
	if status != http.StatusOK {
		t.Fatalf("关闭房间 status = %d", status)
	}
	status, _ = getJSON(t, srv.URL+"/api/rooms/"+roomID)
	if status != http.StatusNotFound {
		t.Fatalf("关闭后 info status = %d, want 404", status)
	}
}

func TestRoomCORSPreflight(t *testing.T) {
	_, srv := newTestAPI(t)
	req, _ := http.NewRequest(http.MethodOptions, srv.URL+"/api/rooms", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "Content-Type, Authorization")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("preflight: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("preflight status = %d, want 204", res.StatusCode)
	}
	if res.Header.Get("Access-Control-Allow-Origin") != "http://localhost:5173" {
		t.Fatalf("CORS 回显异常: %v", res.Header)
	}
	if res.Header.Get("Access-Control-Allow-Headers") != "Content-Type, Authorization" {
		t.Fatalf("CORS 头白名单异常: %v", res.Header)
	}
}

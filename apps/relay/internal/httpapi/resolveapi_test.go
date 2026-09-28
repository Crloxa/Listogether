// resolveapi_test.go：链接解析端点（鉴权/权限/限流/错误映射/SSRF 拒绝路径）。
package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"listogether/apps/relay/internal/hub"
	"listogether/apps/relay/internal/oauth"
	"listogether/apps/relay/internal/providers"
)

// stubProvider：确定性 provider（不做真实 HTTP；匹配 stub.example 域）。
type stubProvider struct{}

func (s *stubProvider) ID() string { return "stub" }
func (s *stubProvider) Match(u *url.URL) bool {
	return strings.HasSuffix(u.Hostname(), "stub.example")
}
func (s *stubProvider) NormalizeURL(raw string) (string, error) {
	parts := strings.SplitN(raw, "?", 2)
	if !strings.HasPrefix(parts[0], "https://stub.example/track/") {
		return "", providers.ErrInvalidURL
	}
	return parts[0], nil
}
func (s *stubProvider) Resolve(_ context.Context, normalized string, _ providers.ResolveOptions) (*providers.TrackInfo, error) {
	return &providers.TrackInfo{
		Platform: "stub", ExternalID: "x1", Title: "Stub Song", Artist: "Stub Artist",
		DurationMs: 123000, Playability: providers.PlayabilityPlayable,
	}, nil
}

func newResolveTestAPI(t *testing.T) (*hub.Hub, *httptest.Server, map[string]any) {
	t.Helper()
	h := hub.New(testLogger)
	t.Cleanup(h.Close)
	reg := providers.NewRegistry()
	reg.Add(&stubProvider{})
	api := NewResolveAPI(testLogger, h, reg, nil)
	mux := http.NewServeMux()
	mux.Handle("POST /api/rooms/{roomId}/links/resolve", WithRoomCORS([]string{"http://localhost:5173"}, api))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	// 建房 + 房主挂载（角色判定在房间 actor）
	created := createRoomForTest(t, h)
	attachHost(t, h, created)
	return h, srv, created
}

func TestResolveRequiresSession(t *testing.T) {
	_, srv, created := newResolveTestAPI(t)
	status, body := postJSON(t, srv.URL+"/api/rooms/"+created["roomId"].(string)+"/links/resolve",
		map[string]any{"url": "https://stub.example/track/x1"}, nil)
	if status != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401, body=%v", status, body)
	}
}

func TestResolveHostOnly(t *testing.T) {
	h, srv, created := newResolveTestAPI(t)
	roomID := created["roomId"].(string)
	listener := joinRoomForTest(t, h, roomID, created)
	attachMember(t, h, roomID, listener["memberId"].(string), "listener")

	status, body := postJSON(t, srv.URL+"/api/rooms/"+roomID+"/links/resolve",
		map[string]any{"url": "https://stub.example/track/x1"},
		map[string]string{"Authorization": "Bearer " + listener["sessionToken"].(string)})
	if status != http.StatusForbidden {
		t.Fatalf("listener 解析应 403, got %d body=%v", status, body)
	}

	// 房主成功
	status, body = postJSON(t, srv.URL+"/api/rooms/"+roomID+"/links/resolve",
		map[string]any{"url": "https://stub.example/track/x1?si=abc"},
		map[string]string{"Authorization": "Bearer " + created["sessionToken"].(string)})
	if status != http.StatusOK {
		t.Fatalf("房主解析应 200, got %d body=%v", status, body)
	}
	if body["title"] != "Stub Song" || body["normalizedUrl"] != "https://stub.example/track/x1" {
		t.Fatalf("unexpected body: %v", body)
	}
}

func TestResolveUnsupportedPlatform(t *testing.T) {
	_, srv, created := newResolveTestAPI(t)
	status, body := postJSON(t, srv.URL+"/api/rooms/"+created["roomId"].(string)+"/links/resolve",
		map[string]any{"url": "https://unknown-platform.example/track/1"},
		map[string]string{"Authorization": "Bearer " + created["sessionToken"].(string)})
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body=%v", status, body)
	}
	if body["code"] != "PLATFORM_UNSUPPORTED" {
		t.Fatalf("code = %v, want PLATFORM_UNSUPPORTED", body["code"])
	}
}

func TestResolvePrivateAddressRejected(t *testing.T) {
	// 私网地址不匹配任何平台 → 平台不支持（不会发起到内网的请求）
	_, srv, created := newResolveTestAPI(t)
	status, body := postJSON(t, srv.URL+"/api/rooms/"+created["roomId"].(string)+"/links/resolve",
		map[string]any{"url": "http://192.168.1.1:8080/api"},
		map[string]string{"Authorization": "Bearer " + created["sessionToken"].(string)})
	if status != http.StatusBadRequest {
		t.Fatalf("私网地址应 400, got %d body=%v", status, body)
	}
}

func TestResolveRateLimited(t *testing.T) {
	_, srv, created := newResolveTestAPI(t)
	url := srv.URL + "/api/rooms/" + created["roomId"].(string) + "/links/resolve"
	headers := map[string]string{"Authorization": "Bearer " + created["sessionToken"].(string)}
	for i := 0; i < 10; i++ {
		status, _ := postJSON(t, url, map[string]any{"url": "https://stub.example/track/x1"}, headers)
		if status != http.StatusOK {
			t.Fatalf("第 %d 次应 200, got %d", i+1, status)
		}
	}
	status, body := postJSON(t, url, map[string]any{"url": "https://stub.example/track/x1"}, headers)
	if status != http.StatusTooManyRequests || body["code"] != "RATE_LIMITED" {
		t.Fatalf("第 11 次应 429 RATE_LIMITED, got %d body=%v", status, body)
	}
}

func TestResolveErrorMapping(t *testing.T) {
	cases := []struct {
		err  error
		want int
		code string
	}{
		{providers.ErrUnsupportedPlatform, http.StatusBadRequest, "PLATFORM_UNSUPPORTED"},
		{providers.ErrInvalidURL, http.StatusBadRequest, "INVALID_MESSAGE"},
		{providers.ErrProviderUnavailable, http.StatusBadGateway, "PROVIDER_UNAVAILABLE"},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		writeResolveError(rec, c.err)
		if rec.Code != c.want {
			t.Fatalf("%v: status = %d, want %d", c.err, rec.Code, c.want)
		}
		if !strings.Contains(rec.Body.String(), c.code) {
			t.Fatalf("%v: body 缺少 %s: %s", c.err, c.code, rec.Body.String())
		}
	}
}

func TestOAuthEndpointsNotConfigured(t *testing.T) {
	h := hub.New(testLogger)
	t.Cleanup(h.Close)
	mgr := oauth.NewManager(oauth.Config{}, "", h.SessionExistsByHash, testLogger)
	srv := httptest.NewServer(NewOAuthAPI(testLogger, h, mgr, []string{"http://localhost:5173"}))
	t.Cleanup(srv.Close)
	created := createRoomForTest(t, h)
	attachHost(t, h, created)

	// 未配置凭证：start → 503 OAUTH_NOT_CONFIGURED
	status, body := postJSON(t, srv.URL+"/api/oauth/spotify/start", nil,
		map[string]string{"Authorization": "Bearer " + created["sessionToken"].(string)})
	if status != http.StatusServiceUnavailable || body["code"] != "OAUTH_NOT_CONFIGURED" {
		t.Fatalf("status = %d body=%v, want 503 OAUTH_NOT_CONFIGURED", status, body)
	}

	// providers 列表：无会话 → 401（不暴露配置状态）
	status, _ = getJSON(t, srv.URL+"/api/oauth/providers")
	if status != http.StatusUnauthorized {
		t.Fatalf("无会话的 providers 查询应 401, got %d", status)
	}
}

func TestOAuthCallbackBadState(t *testing.T) {
	h := hub.New(testLogger)
	t.Cleanup(h.Close)
	mgr := oauth.NewManager(oauth.Config{}, "https://relay.example", h.SessionExistsByHash, testLogger)
	srv := httptest.NewServer(NewOAuthAPI(testLogger, h, mgr, []string{"http://localhost:5173"}))
	t.Cleanup(srv.Close)
	res, err := http.Get(srv.URL + "/api/oauth/spotify/callback?code=x&state=bad")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("坏 state 应 400, got %d", res.StatusCode)
	}
}

// ---- 测试工具（复用 roomapi_test 的模式） ----

func createRoomForTest(t *testing.T, h *hub.Hub) map[string]any {
	t.Helper()
	result, herr := h.CreateRoom(hub.CreateOptions{HostName: "房主", MaxMembers: 8})
	if herr != nil {
		t.Fatalf("create room: %v", herr)
	}
	return map[string]any{
		"roomId":       result.RoomID,
		"sessionToken": result.SessionToken,
		"memberId":     result.MemberID,
		"inviteToken":  result.InviteToken,
	}
}

func joinRoomForTest(t *testing.T, h *hub.Hub, roomID string, created map[string]any) map[string]any {
	t.Helper()
	result, herr := h.Join(roomID, hub.JoinOptions{InviteToken: created["inviteToken"].(string), Name: "成员B"})
	if herr != nil {
		t.Fatalf("join: %v", herr)
	}
	return map[string]any{
		"sessionToken": result.SessionToken,
		"memberId":     result.MemberID,
	}
}

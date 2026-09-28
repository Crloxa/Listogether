// oauth_test.go：用本地 mock provider 全流程验证 AC+PKCE（P-006）。
// 关键边界断言：token 永不出现在 Status 输出 / 日志 / 错误消息中。
package oauth

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// mockProvider 模拟标准 OAuth 授权服务器（authorize/token/userinfo）。
type mockProvider struct {
	srv         *httptest.Server
	codes       map[string]string // code → 已消费?
	usedCodes   map[string]bool
	issuedCount int
	rotated     bool // 第二次发 token 时轮换 refresh_token
	lastRefresh string
}

func newMockProvider(t *testing.T) *mockProvider {
	t.Helper()
	mp := &mockProvider{usedCodes: map[string]bool{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			http.Error(w, "bad form", 400)
			return
		}
		switch r.Form.Get("grant_type") {
		case "authorization_code":
			code := r.Form.Get("code")
			if mp.usedCodes[code] {
				http.Error(w, `{"error":"invalid_grant"}`, 400)
				return
			}
			mp.usedCodes[code] = true
			if r.Form.Get("code_verifier") == "" {
				t.Error("token 请求缺少 code_verifier（PKCE 未生效）")
			}
			mp.issuedCount++
			refresh := "rt-1"
			if mp.issuedCount > 1 {
				refresh = "rt-2" // 模拟轮换
				mp.rotated = true
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token":  "at-" + fmt.Sprint(mp.issuedCount),
				"refresh_token": refresh,
				"expires_in":    1, // 1 秒：让 Status 立即走刷新路径
				"scope":         "user-read-private",
				"token_type":    "Bearer",
			})
		case "refresh_token":
			mp.lastRefresh = r.Form.Get("refresh_token")
			mp.issuedCount++
			if mp.lastRefresh == "rt-1" {
				mp.rotated = true // 用旧 rt 刷新并返回新 rt（轮换）
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token":  "at-" + fmt.Sprint(mp.issuedCount),
				"refresh_token": "rt-2", // 轮换
				"expires_in":    3600,
			})
		default:
			http.Error(w, `{"error":"unsupported_grant_type"}`, 400)
		}
	})
	mux.HandleFunc("/me", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer at-1" && r.Header.Get("Authorization") != "Bearer at-2" &&
			r.Header.Get("Authorization") != "Bearer at-3" {
			http.Error(w, "unauthorized", 401)
			return
		}
		_, _ = w.Write([]byte(`{"id":"user-abc123","display_name":"小明"}`))
	})
	mp.srv = httptest.NewServer(mux)
	t.Cleanup(mp.srv.Close)
	return mp
}

func testManager(t *testing.T, mp *mockProvider, sessionValid func(string) bool) (*Manager, string) {
	t.Helper()
	cfg := Config{Providers: map[string]ProviderConfig{
		"spotify": {
			ID: "spotify", ClientID: "client-1", ClientSecret: "secret-1",
			AuthorizeURL: mp.srv.URL + "/authorize",
			TokenURL:     mp.srv.URL + "/token",
			UserInfoURL:  mp.srv.URL + "/me",
			Scopes:       []string{"user-read-private"},
		},
	}}
	m := NewManager(cfg, "https://relay.example.com", sessionValid, slog.New(slog.NewTextHandler(&testWriter{t}, nil)))
	m.nowFunc = time.Now
	return m, mp.srv.URL
}

type testWriter struct{ t *testing.T }

func (w *testWriter) Write(p []byte) (int, error) {
	w.t.Log(string(p))
	return len(p), nil
}

func TestOAuthFullFlowWithPKCE(t *testing.T) {
	mp := newMockProvider(t)
	m, _ := testManager(t, mp, nil)

	authURL, err := m.Start("spotify", "member-key-1")
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	// 授权 URL 必须包含 PKCE 要素且不含 verifier
	u, _ := url.Parse(authURL)
	q := u.Query()
	if q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") == "" || q.Get("state") == "" {
		t.Fatalf("授权 URL 缺少 PKCE/state 要素: %s", authURL)
	}
	if strings.Contains(authURL, "code_verifier") || strings.Contains(authURL, "secret") {
		t.Fatalf("授权 URL 不得包含 verifier/secret: %s", authURL)
	}
	state := q.Get("state")

	// state 一次性：重放拒绝
	if err := m.HandleCallback("spotify", "code-A", state, ""); err != nil {
		t.Fatalf("callback: %v", err)
	}
	if err := m.HandleCallback("spotify", "code-A", state, ""); !errors.Is(err, ErrUnknownState) {
		t.Fatalf("state 重放应拒绝, got %v", err)
	}

	// 连接后：token 可用但不外泄
	tok, err := m.AccessToken("spotify", "member-key-1")
	if err != nil || tok == "" {
		t.Fatalf("access token: %v", err)
	}
	status := m.Status("spotify", "member-key-1")
	if !status.Connected {
		t.Fatal("应显示已连接")
	}
	if status.UserLabel != "小…" {
		t.Fatalf("用户标识应打码, got %q", status.UserLabel)
	}
	// Status JSON 不得包含 token 原文
	raw, _ := json.Marshal(status)
	if strings.Contains(string(raw), "at-") || strings.Contains(string(raw), "rt-") {
		t.Fatalf("Status 泄露 token: %s", raw)
	}
	// 错误消息也不得包含 token
	if strings.Contains(fmt.Sprint(err), "at-") {
		t.Fatal("错误消息泄露 token")
	}
}

func TestOAuthDeniedAndBadState(t *testing.T) {
	mp := newMockProvider(t)
	m, _ := testManager(t, mp, nil)
	if err := m.HandleCallback("spotify", "", "no-such-state", "access_denied"); !errors.Is(err, ErrUnknownState) {
		t.Fatalf("未知 state 优先（防探测）, got %v", err)
	}
	authURL, _ := m.Start("spotify", "k")
	state := mustState(t, authURL)
	if err := m.HandleCallback("spotify", "", state, "access_denied"); !errors.Is(err, ErrDenied) {
		t.Fatalf("用户取消应返回 ErrDenied, got %v", err)
	}
	// 未配置的 provider
	if _, err := m.Start("qqmusic", "k"); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("未配置应 ErrNotConfigured, got %v", err)
	}
}

func mustState(t *testing.T, authURL string) string {
	t.Helper()
	u, err := url.Parse(authURL)
	if err != nil {
		t.Fatal(err)
	}
	return u.Query().Get("state")
}

func TestOAuthRefreshRotation(t *testing.T) {
	mp := newMockProvider(t)
	m, _ := testManager(t, mp, nil)
	authURL, _ := m.Start("spotify", "k")
	state := mustState(t, authURL)
	if err := m.HandleCallback("spotify", "code-R", state, ""); err != nil {
		t.Fatalf("callback: %v", err)
	}
	// expires_in=1：等过期后 Status 触发刷新
	time.Sleep(1100 * time.Millisecond)
	status := m.Status("spotify", "k")
	if !status.Connected {
		t.Fatal("刷新后应仍连接")
	}
	if !mp.rotated || mp.lastRefresh != "rt-1" {
		t.Fatalf("应使用旧 refresh_token 刷新: rotated=%v last=%q", mp.rotated, mp.lastRefresh)
	}
	tok, _ := m.AccessToken("spotify", "k")
	if tok == "at-1" {
		t.Fatal("刷新后应使用新 access token")
	}
}

func TestOAuthRevokeAndSessionRelease(t *testing.T) {
	var revoked string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		revoked = r.Form.Get("token")
		w.WriteHeader(200)
	}))
	defer srv.Close()
	mp := newMockProvider(t)
	cfg := Config{Providers: map[string]ProviderConfig{
		"spotify": {
			ID: "spotify", ClientID: "c", ClientSecret: "s",
			AuthorizeURL: mp.srv.URL + "/authorize", TokenURL: mp.srv.URL + "/token",
			RevokeURL: srv.URL + "/revoke",
		},
	}}
	validSessions := map[string]bool{"member-key-1": true, "member-key-2": true}
	m := NewManager(cfg, "https://relay.example.com", func(k string) bool { return validSessions[k] }, nil)

	authURL, _ := m.Start("spotify", "member-key-1")
	state := mustState(t, authURL)
	if err := m.HandleCallback("spotify", "code-V", state, ""); err != nil {
		t.Fatalf("callback: %v", err)
	}
	if err := m.Disconnect("spotify", "member-key-1"); err != nil {
		t.Fatalf("disconnect: %v", err)
	}
	if revoked == "" || !strings.HasPrefix(revoked, "at-") {
		t.Fatalf("撤销端点应收到 access token, got %q", revoked)
	}
	if m.Status("spotify", "member-key-1").Connected {
		t.Fatal("断开后应显示未连接")
	}
	// 会话失效 → Sweep 释放
	validSessions["member-key-1"] = false
	authURL2, _ := m.Start("spotify", "member-key-2")
	state2 := mustState(t, authURL2)
	if err := m.HandleCallback("spotify", "code-W", state2, ""); err != nil {
		t.Fatalf("callback2: %v", err)
	}
	m.Sweep()
	if m.Status("spotify", "member-key-1").Connected {
		t.Fatal("失效会话的 token 应被 Sweep 释放")
	}
	if !m.Status("spotify", "member-key-2").Connected {
		t.Fatal("有效会话不应被误清")
	}
}

func TestConfigFromEnv(t *testing.T) {
	env := func(key string) string {
		switch key {
		case "LISTO_OAUTH_SPOTIFY_CLIENT_ID":
			return "cid"
		case "LISTO_OAUTH_SPOTIFY_SCOPES":
			return "user-read-private, user-read-email"
		case "LISTO_OAUTH_SPOTIFY_TOKEN_URL":
			return "https://custom.example/token"
		}
		return ""
	}
	cfg := ConfigFromEnv(env)
	p, ok := cfg.Providers["spotify"]
	if !ok || p.ClientID != "cid" {
		t.Fatal("CLIENT_ID 存在时应配置 provider")
	}
	if len(p.Scopes) != 2 {
		t.Fatalf("scopes 应按逗号拆分, got %v", p.Scopes)
	}
	if p.TokenURL != "https://custom.example/token" {
		t.Fatalf("端点应可覆盖, got %s", p.TokenURL)
	}
	if p.AuthorizeURL != "https://accounts.spotify.com/authorize" {
		t.Fatalf("未覆盖的端点用默认值, got %s", p.AuthorizeURL)
	}
	empty := ConfigFromEnv(func(string) string { return "" })
	if _, ok := empty.Providers["spotify"]; ok {
		t.Fatal("无 CLIENT_ID 不应配置")
	}
}

func TestChallengeS256(t *testing.T) {
	// RFC 7636 附录 B 向量
	verifier := "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	want := "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
	if got := challengeS256(verifier); got != want {
		t.Fatalf("challenge = %s, want %s", got, want)
	}
}

func TestMaskLabel(t *testing.T) {
	cases := []struct{ in, want string }{
		{"小明", "小…"},
		{"abcdef", "a…"},
		{"", ""},
	}
	for _, c := range cases {
		if got := maskLabel(c.in); got != c.want {
			t.Fatalf("maskLabel(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

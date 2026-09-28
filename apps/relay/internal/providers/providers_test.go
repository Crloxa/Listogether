// providers_test.go 覆盖：URL 规范化矩阵（与 TS 侧 fixtures 同源）、SSRF 防护、
// 各 provider 解析（httptest mock：成功/不存在/需登录/网络失败）、重定向白名单。
package providers

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// ---- URL 规范化矩阵 ----

type normCase struct {
	raw        string
	platform   string
	normalized string
}

func TestNormalizeURLMatrix(t *testing.T) {
	cases := []normCase{
		{raw: "https://music.163.com/song?id=347230&userid=1", platform: PlatformNetEase, normalized: "https://music.163.com/song?id=347230"},
		{raw: "https://music.163.com/song/347230/?from=search", platform: PlatformNetEase, normalized: "https://music.163.com/song?id=347230"},
		{raw: "https://y.qq.com/n/yqq/song/0039MnYb0qxYhV.html?stat=y.yy", platform: PlatformQQMusic, normalized: "https://y.qq.com/n/yqq/song/0039MnYb0qxYhV.html"},
		{raw: "https://i.y.qq.com/n2/m/share/details/mb.html?songmid=0039MnYb0qxYhV", platform: PlatformQQMusic, normalized: "https://y.qq.com/n/yqq/song/0039MnYb0qxYhV.html"},
		{raw: "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=abc", platform: PlatformSpotify, normalized: "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"},
		{raw: "https://open.spotify.com/intl-zh-CN/track/4cOdK2wGLETKBW3PvgPWqT", platform: PlatformSpotify, normalized: "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"},
		{raw: "https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT", platform: PlatformSpotify, normalized: "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"},
		{raw: "https://music.youtube.com/watch?v=dQw4w9WgXcQ&si=xyz", platform: PlatformYTMusic, normalized: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
		{raw: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s", platform: PlatformYTMusic, normalized: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
		{raw: "https://youtu.be/dQw4w9WgXcQ?si=abc", platform: PlatformYTMusic, normalized: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
	}
	reg := NewRegistry()
	for _, c := range cases {
		p, normalized, err := reg.Find(c.raw)
		if err != nil {
			t.Fatalf("%s: 意外失败: %v", c.raw, err)
		}
		if p.ID() != c.platform {
			t.Fatalf("%s: platform = %s, want %s", c.raw, p.ID(), c.platform)
		}
		if normalized != c.normalized {
			t.Fatalf("%s: normalized = %s, want %s", c.raw, normalized, c.normalized)
		}
	}
}

func TestNormalizeURLRejects(t *testing.T) {
	cases := []struct {
		raw    string
		reason string
	}{
		{"https://example.com/song?id=1", "未知平台"},
		{"https://music.163.com/album?id=1", "非单曲（专辑）"},
		{"https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy", "Spotify 专辑"},
		{"https://music.163.com/song?id=abc", "网易 id 非数字"},
		{"https://music.163.com/song", "缺少 id"},
		{"ftp://music.163.com/song?id=1", "非 http(s)"},
		{"https://music.163.com/song?id=" + strings.Repeat("1", 25), "id 过长"},
		{"", "空链接"},
		{"://broken", "无法解析"},
	}
	reg := NewRegistry()
	for _, c := range cases {
		if _, _, err := reg.Find(c.raw); err == nil {
			t.Fatalf("%s 应被拒绝（%s）", c.raw, c.reason)
		}
	}
}

// ---- SSRF 防护 ----

func TestSafeClientRejectsPrivateAddresses(t *testing.T) {
	// httptest 必然落在 127.0.0.1：安全客户端必须拒绝直连
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	defer srv.Close()
	client := safeClient([]string{strings.TrimPrefix(srv.URL, "http://")}, 3*time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL, nil)
	if _, err := client.Do(req); err == nil {
		t.Fatal("对回环地址的请求应被 SSRF 防护拒绝")
	}
}

func TestSafeClientRejectsCrossHostRedirect(t *testing.T) {
	outer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://127.0.0.1:1/escape", http.StatusFound)
	}))
	defer outer.Close()
	// 注入绕过白名单的裸 client：直接用 safeClient 但白名单含其主机，重定向目标是私网 → 被 IP 检查拦
	client := safeClient([]string{"localhost", "127.0.0.1"}, 3*time.Second)
	_, err := client.Get(outer.URL)
	if err == nil {
		t.Fatal("重定向到私网地址应被拒绝")
	}
}

func TestForbiddenIP(t *testing.T) {
	forbidden := []string{
		"127.0.0.1", "10.0.0.5", "172.16.1.1", "192.168.1.1", "169.254.1.1",
		"100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fc00::1", "::ffff:192.168.0.1",
	}
	for _, s := range forbidden {
		ip := parseIP(s)
		if !forbiddenIP(ip) {
			t.Fatalf("%s 应被禁止", s)
		}
	}
	allowed := []string{"8.8.8.8", "1.1.1.1", "2606:4700::1111"}
	for _, s := range allowed {
		ip := parseIP(s)
		if forbiddenIP(ip) {
			t.Fatalf("%s 不应被禁止", s)
		}
	}
}

// ---- 解析流程（httptest mock） ----

func TestNetEaseResolve(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/api/song/detail") {
			w.WriteHeader(404)
			return
		}
		if r.URL.Query().Get("id") == "0" {
			_, _ = w.Write([]byte(`{"songs":[],"code":200}`))
			return
		}
		_, _ = w.Write([]byte(`{"code":200,"songs":[{"name":"海阔天空","id":347230,"duration":326000,"fee":1,
			"artists":[{"name":"Beyond"}],"album":{"name":"海阔天空","picUrl":"https://p1.music.126.net/x.jpg"}}]}`))
	}))
	defer srv.Close()
	p := &NetEase{apiBase: srv.URL}
	normalized, err := p.NormalizeURL("https://music.163.com/song?id=347230")
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	info, err := p.Resolve(context.Background(), normalized, ResolveOptions{HTTPClient: srv.Client()})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if info.Title != "海阔天空" || info.Artist != "Beyond" || info.DurationMs != 326000 {
		t.Fatalf("unexpected info: %+v", info)
	}
	if info.Playability != PlayabilityNeedsLogin {
		t.Fatalf("fee=1 应映射 needs_login, got %s", info.Playability)
	}
	// 空歌曲列表 → unavailable（不是错误）
	empty, err := p.Resolve(context.Background(), p.apiBase+"/song?id=0", ResolveOptions{HTTPClient: srv.Client()})
	_ = empty
	_ = err
}

func TestNetEaseResolveUnavailableIsNotError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"songs":[],"code":200}`))
	}))
	defer srv.Close()
	p := &NetEase{apiBase: srv.URL}
	info, err := p.Resolve(context.Background(), "https://music.163.com/song?id=0", ResolveOptions{HTTPClient: srv.Client()})
	if err != nil {
		t.Fatalf("平台表示不存在不应返回错误: %v", err)
	}
	if info.Playability != PlayabilityUnavailable {
		t.Fatalf("expected unavailable, got %s", info.Playability)
	}
}

func TestQQMusicResolve(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("songmid") == "emptyMID1" {
			_, _ = w.Write([]byte(`{"code":0,"data":[]}`))
			return
		}
		_, _ = w.Write([]byte(`{"code":0,"data":[{"title":"晴天","songname":"","mid":"0039MnYb0qxYhV",
			"interval":269,"singer":[{"name":"周杰伦"}],"album":{"name":"叶惠美","mid":"002eFUFm2XYZ7z"},
			"pay":{"pay_play":1}}]}`))
	}))
	defer srv.Close()
	p := &QQMusic{apiBase: srv.URL}
	normalized, err := p.NormalizeURL("https://y.qq.com/n/yqq/song/0039MnYb0qxYhV.html")
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	info, err := p.Resolve(context.Background(), normalized, ResolveOptions{HTTPClient: srv.Client()})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if info.Title != "晴天" || info.Artist != "周杰伦" || info.DurationMs != 269000 {
		t.Fatalf("unexpected info: %+v", info)
	}
	if info.Playability != PlayabilityNeedsLogin {
		t.Fatalf("pay_play=1 应映射 needs_login, got %s", info.Playability)
	}
	if !strings.Contains(info.CoverURL, "y.gtimg.cn") {
		t.Fatalf("expected qq cover url, got %s", info.CoverURL)
	}
	// 空 data → unavailable（P-002）
	emptyURL := srv.URL + "/n/yqq/song/emptyMID1.html"
	p2 := &QQMusic{apiBase: srv.URL}
	info2, err := p2.Resolve(context.Background(), emptyURL, ResolveOptions{HTTPClient: srv.Client()})
	if err != nil {
		t.Fatalf("空 data 不应返回错误: %v", err)
	}
	if info2.Playability != PlayabilityUnavailable {
		t.Fatalf("空 data 应映射 unavailable, got %s", info2.Playability)
	}
}

func TestSpotifyOEmbedUnavailableOn404(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not found", http.StatusNotFound)
	}))
	defer srv.Close()
	p := &Spotify{oembedBase: srv.URL, apiBase: srv.URL}
	info, err := p.Resolve(context.Background(), srv.URL+"/track/4cOdK2wGLETKBW3PvgPWqT", ResolveOptions{HTTPClient: srv.Client()})
	if err != nil {
		t.Fatalf("oEmbed 404 应映射为 unavailable: %v", err)
	}
	if info.Playability != PlayabilityUnavailable {
		t.Fatalf("expected unavailable, got %s", info.Playability)
	}
}

func TestSpotifyResolveWithToken(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"id":"4cOdK2wGLETKBW3PvgPWqT","name":"Never Gonna Give You Up","duration_ms":213000,
			"artists":[{"name":"Rick Astley"}],"album":{"name":"Whenever You Need Somebody",
			"images":[{"url":"https://i.scdn.co/x.jpg"}]},"is_playable":true}`))
	}))
	defer srv.Close()
	p := &Spotify{oembedBase: srv.URL, apiBase: srv.URL}
	info, err := p.Resolve(context.Background(), srv.URL+"/track/4cOdK2wGLETKBW3PvgPWqT",
		ResolveOptions{HTTPClient: srv.Client(), Token: "test-token"})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if gotAuth != "Bearer test-token" {
		t.Fatalf("token 应随请求发送, got %q", gotAuth)
	}
	if info.DurationMs != 213000 || info.Artist != "Rick Astley" || info.Playability != PlayabilityPlayable {
		t.Fatalf("unexpected info: %+v", info)
	}
}

func TestYTMusicResolve(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"title":"Rick Astley - Never Gonna Give You Up","author_name":"Rick Astley",
			"thumbnail_url":"https://i.ytimg.com/vi/x/hqdefault.jpg"}`))
	}))
	defer srv.Close()
	p := &YTMusic{oembedBase: srv.URL}
	info, err := p.Resolve(context.Background(), srv.URL+"/watch?v=dQw4w9WgXcQ", ResolveOptions{HTTPClient: srv.Client()})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if info.Title == "" || info.Artist != "Rick Astley" {
		t.Fatalf("unexpected info: %+v", info)
	}
}

func TestResolveNetworkFailureIsExplainable(t *testing.T) {
	// 指向立即关闭的服务器：模拟平台不可达（PROVIDERS.md P-001 的自动化形态）
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := srv.URL
	srv.Close()
	p := &NetEase{apiBase: url}
	_, err := p.Resolve(context.Background(), url+"/song?id=1", ResolveOptions{HTTPClient: srv.Client()})
	if err == nil || !errors.Is(err, ErrProviderUnavailable) {
		t.Fatalf("网络失败应返回 ErrProviderUnavailable, got %v", err)
	}
}

func parseIP(s string) net.IP { return net.ParseIP(s) }

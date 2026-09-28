// Package providers 实现音乐平台链接的可插拔识别与元数据解析（D-014）。
//
// 安全边界（硬性）：
//   - 仅 https，host 必须在对应 provider 白名单内；
//   - 每次拨号前校验解析出的 IP（拒绝私网/回环/链路本地/CGNAT，SSRF 防护）；
//   - 重定向目标重新过白名单；响应体 ≤1MB；总超时由调用方控制。
//
// 平台不可达是常态（如本机网络无法访问 Spotify/YouTube，见 docs/PROVIDERS.md P-001），
// 所有失败都必须以可解释的错误/状态返回，绝不静默。
package providers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"syscall"
	"time"

	"listogether/apps/relay/internal/protocol"
)

// 平台标识（与 canonical schema 的 trackSource.platform 一致）。
const (
	PlatformNetEase = "netease"
	PlatformQQMusic = "qqmusic"
	PlatformSpotify = "spotify"
	PlatformYTMusic = "ytmusic"
	PlatformOther   = "other"
)

// Playability 是平台侧可用性判断；不代表房间内可播（D-014）。
type Playability string

const (
	PlayabilityPlayable    Playability = "playable"
	PlayabilityNeedsLogin  Playability = "needs_login"
	PlayabilityPreviewOnly Playability = "preview_only"
	PlayabilityRegionLock  Playability = "region_locked"
	PlayabilityUnavailable Playability = "unavailable"
	PlayabilityUnknown     Playability = "unknown"
)

// 语义化错误：调用方（HTTP 层）据此映射状态码与用户消息。
var (
	// ErrInvalidURL 链接形状非法（非 https/超长/无法解析）。
	ErrInvalidURL = errors.New("invalid url")
	// ErrUnsupportedPlatform 不支持的平台或非单曲链接。
	ErrUnsupportedPlatform = errors.New("unsupported platform")
	// ErrProviderUnavailable 平台网络不可达/超时/响应异常（环境性失败）。
	ErrProviderUnavailable = errors.New("provider unavailable")
	// errForbiddenTarget SSRF 防护触发（对内为内部错误，对外统一表现为 unavailable）。
	errForbiddenTarget = errors.New("forbidden target address")
)

const maxResponseBytes = 1 << 20 // 1MB

// TrackInfo 是一次成功解析的元数据结果。
type TrackInfo struct {
	Platform    string      `json:"platform"`
	ExternalID  string      `json:"externalId,omitempty"`
	Title       string      `json:"title,omitempty"`
	Artist      string      `json:"artist,omitempty"`
	Album       string      `json:"album,omitempty"`
	DurationMs  int64       `json:"durationMs,omitempty"`
	CoverURL    string      `json:"coverUrl,omitempty"`
	Playability Playability `json:"playability"`
	Message     string      `json:"message,omitempty"`
}

// ResolveOptions 是一次解析的运行参数；HTTPClient 供测试注入（生产为 nil → 安全客户端）。
type ResolveOptions struct {
	// OAuth access token（成员已连接平台账号时传入；适配器自行决定是否使用）。
	Token string
	// HTTPClient 为 nil 时使用带 SSRF 防护的默认客户端。
	HTTPClient *http.Client
}

// Provider 是单个音乐平台的适配器。
type Provider interface {
	// ID 返回平台标识（trackSource.platform 取值）。
	ID() string
	// Match 判断 URL 是否属于该平台（已过基础合法性）。
	Match(u *url.URL) bool
	// NormalizeURL 把任意合法形态规范化为单一形态；非法返回 ErrInvalidURL/ErrUnsupportedPlatform。
	NormalizeURL(raw string) (string, error)
	// Resolve 拉取元数据；网络失败返回 ErrProviderUnavailable，
	// 平台明确表示歌曲不存在时返回 TrackInfo{Playability: unavailable}（不是错误）。
	Resolve(ctx context.Context, normalizedURL string, opts ResolveOptions) (*TrackInfo, error)
}

// Registry 是全部已注册 provider 的集合。
type Registry struct{ providers []Provider }

// Bases 是平台 API 端点覆盖（D-019 运维切换）；空字段用内置默认。
type Bases struct {
	NetEaseAPIBase    string
	QQMusicAPIBase    string
	SpotifyOEmbedBase string
	SpotifyAPIBase    string
	YouTubeOEmbedBase string
}

// NewRegistry 返回内置平台适配器集合（顺序即匹配优先级）。
func NewRegistry() *Registry { return NewRegistryWithBases(Bases{}) }

// NewRegistryWithBases 允许通过配置覆盖平台 API 端点（D-019）。
func NewRegistryWithBases(b Bases) *Registry {
	netease := NewNetEase()
	if b.NetEaseAPIBase != "" {
		netease.apiBase = b.NetEaseAPIBase
	}
	qq := NewQQMusic()
	if b.QQMusicAPIBase != "" {
		qq.apiBase = b.QQMusicAPIBase
	}
	spotify := NewSpotify()
	if b.SpotifyOEmbedBase != "" {
		spotify.oembedBase = b.SpotifyOEmbedBase
	}
	if b.SpotifyAPIBase != "" {
		spotify.apiBase = b.SpotifyAPIBase
	}
	yt := NewYTMusic()
	if b.YouTubeOEmbedBase != "" {
		yt.oembedBase = b.YouTubeOEmbedBase
	}
	return &Registry{providers: []Provider{netease, qq, spotify, yt}}
}

// Add 追加自定义适配器（置于内置之前；可插拔扩展点，测试用 mock 也走这里）。
func (r *Registry) Add(p Provider) { r.providers = append([]Provider{p}, r.providers...) }

// Find 匹配并规范化链接；返回 provider 与规范化 URL。
func (r *Registry) Find(raw string) (Provider, string, error) {
	u, err := parseRawURL(raw)
	if err != nil {
		return nil, "", err
	}
	for _, p := range r.providers {
		if p.Match(u) {
			normalized, nerr := p.NormalizeURL(raw)
			if nerr != nil {
				return nil, "", nerr
			}
			return p, normalized, nil
		}
	}
	return nil, "", fmt.Errorf("%w: 识别不了该链接的平台", ErrUnsupportedPlatform)
}

// Resolve 匹配并解析；返回结果与规范化 URL。
func (r *Registry) Resolve(ctx context.Context, raw string, opts ResolveOptions) (*TrackInfo, string, error) {
	p, normalized, err := r.Find(raw)
	if err != nil {
		return nil, "", err
	}
	info, err := p.Resolve(ctx, normalized, opts)
	if err != nil {
		return nil, normalized, err
	}
	return info, normalized, nil
}

// ---- 链接基础校验 ----

// parseRawURL 做所有 provider 共同的基础校验：https、可解析、长度受限。
func parseRawURL(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, fmt.Errorf("%w: 链接为空", ErrInvalidURL)
	}
	if len(raw) > protocol.MaxSourceURLLen+2048 { // 传入侧宽松，规范化后受限
		return nil, fmt.Errorf("%w: 链接过长", ErrInvalidURL)
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("%w: 链接无法解析", ErrInvalidURL)
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return nil, fmt.Errorf("%w: 只接受 http(s) 链接", ErrInvalidURL)
	}
	if u.Host == "" {
		return nil, fmt.Errorf("%w: 缺少主机名", ErrInvalidURL)
	}
	return u, nil
}

// ---- SSRF 防护的 HTTP 客户端 ----

// forbiddenIP 判断 IP 是否禁止直连（私网/回环/链路本地/CGNAT/组播/未指定/IPv6 ULA）。
func forbiddenIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsMulticast() || ip.IsUnspecified() {
		return true
	}
	if ip4 := ip.To4(); ip4 != nil {
		// CGNAT 100.64.0.0/10
		if ip4[0] == 100 && ip4[1] >= 64 && ip4[1] < 128 {
			return true
		}
		return false
	}
	// IPv6 ULA fc00::/7
	return len(ip) == 16 && ip[0]&0xfe == 0xfc
}

// safeClient 返回带 SSRF 防护的 HTTP 客户端：
// 每次连接前校验已解析 IP；重定向必须回到 providerHosts 白名单内的 https 地址。
func safeClient(providerHosts []string, timeout time.Duration) *http.Client {
	allow := make(map[string]struct{}, len(providerHosts))
	for _, h := range providerHosts {
		allow[strings.ToLower(h)] = struct{}{}
	}
	transport := &http.Transport{
		Proxy: nil, // 不使用代理：直连目标，保证 IP 校验有效
		DialContext: (&net.Dialer{
			Timeout: 5 * time.Second,
			Control: func(_, address string, _ syscall.RawConn) error {
				host, _, err := net.SplitHostPort(address)
				if err != nil {
					return err
				}
				ip := net.ParseIP(host)
				if forbiddenIP(ip) {
					return errForbiddenTarget
				}
				return nil
			},
		}).DialContext,
	}
	client := &http.Client{
		Timeout:   timeout,
		Transport: transport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 3 {
				return fmt.Errorf("%w: 重定向次数过多", ErrProviderUnavailable)
			}
			if req.URL.Scheme != "https" {
				return fmt.Errorf("%w: 重定向到非 https", ErrProviderUnavailable)
			}
			if _, ok := allow[strings.ToLower(req.URL.Hostname())]; !ok {
				return fmt.Errorf("%w: 重定向到白名单以外的主机", ErrProviderUnavailable)
			}
			return nil
		},
	}
	return client
}

// httpStatusError 是平台返回非 2xx 的错误；oEmbed 类平台用 400/404 表示资源不存在，
// 适配器可据此返回 unavailable 状态而不是环境性失败。语义上仍属于平台侧失败（ErrProviderUnavailable）。
type httpStatusError struct {
	Status int
	Desc   string
}

func (e *httpStatusError) Error() string { return e.Desc }

func (e *httpStatusError) Unwrap() error { return ErrProviderUnavailable }

// notFoundOEmbed 判断 oEmbed 类平台的 400/404（该形态的"资源不存在"）。
func notFoundOEmbed(err error) bool {
	var hsErr *httpStatusError
	return errors.As(err, &hsErr) && (hsErr.Status == 400 || hsErr.Status == 404)
}

// fetchJSON 用 client 拉取 JSON 并限制响应体大小；非 2xx 返回 *httpStatusError（包在 ErrProviderUnavailable 语义内）。
func fetchJSON(ctx context.Context, client *http.Client, url string, headers map[string]string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("%w: 构造请求失败", ErrProviderUnavailable)
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Listogether/1.0")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("%w: 请求失败（%v）", ErrProviderUnavailable, unwrapURLErr(err))
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &httpStatusError{
			Status: resp.StatusCode,
			Desc:   fmt.Sprintf("平台返回 HTTP %d", resp.StatusCode),
		}
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return fmt.Errorf("%w: 读取响应失败", ErrProviderUnavailable)
	}
	if len(data) > maxResponseBytes {
		return fmt.Errorf("%w: 响应超过 1MB 上限", ErrProviderUnavailable)
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("%w: 响应不是合法 JSON", ErrProviderUnavailable)
	}
	return nil
}

// unwrapURLErr 剥掉 url.Error 包装取根因描述（保持消息简短）。
func unwrapURLErr(err error) error {
	var uerr *url.Error
	if errors.As(err, &uerr) {
		return uerr.Err
	}
	return err
}

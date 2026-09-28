// ytmusic.go 识别并解析 YouTube / YouTube Music 链接。
// oEmbed 公开端点无需鉴权（2026-09 本机网络不可达，见 PROVIDERS.md P-001；
// 适配器保留：URL 匹配/规范化离线可用，解析失败以 PROVIDER_UNAVAILABLE 可解释返回）。
package providers

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const ytOEmbedBase = "https://www.youtube.com"

// YTMusic 是 YouTube( Music) 适配器；端点可注入（测试/mock）。
type YTMusic struct{ oembedBase string }

// NewYTMusic 返回生产配置的适配器。
func NewYTMusic() *YTMusic { return &YTMusic{oembedBase: ytOEmbedBase} }

func (y *YTMusic) ID() string { return PlatformYTMusic }

var ytVideoID = regexp.MustCompile(`^[0-9A-Za-z_-]{11}$`)

func (y *YTMusic) Match(u *url.URL) bool {
	host := strings.ToLower(u.Hostname())
	switch host {
	case "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtube.com":
		return u.Query().Get("v") != "" || strings.HasPrefix(u.Path, "/watch")
	case "youtu.be":
		return strings.Trim(u.Path, "/") != ""
	default:
		return false
	}
}

// NormalizeURL 输出 https://www.youtube.com/watch?v=<id>。
func (y *YTMusic) NormalizeURL(raw string) (string, error) {
	u, err := parseRawURL(raw)
	if err != nil {
		return "", err
	}
	id := u.Query().Get("v")
	if id == "" && u.Hostname() == "youtu.be" {
		id = strings.Trim(u.Path, "/")
	}
	if !ytVideoID.MatchString(id) {
		return "", fmt.Errorf("%w: 链接缺少合法的视频 id", ErrInvalidURL)
	}
	return ytOEmbedBase + "/watch?v=" + id, nil
}

type ytOEmbedResp struct {
	Title        string `json:"title"`
	AuthorName   string `json:"author_name"`
	ThumbnailURL string `json:"thumbnail_url"`
}

// Resolve 走 oEmbed（无需 API key）。404 → unavailable；网络不可达 → ErrProviderUnavailable。
func (y *YTMusic) Resolve(ctx context.Context, normalizedURL string, opts ResolveOptions) (*TrackInfo, error) {
	u, err := url.Parse(normalizedURL)
	if err != nil {
		return nil, fmt.Errorf("%w: 内部规范化结果非法", ErrInvalidURL)
	}
	id := u.Query().Get("v")
	if id == "" {
		return nil, fmt.Errorf("%w: 内部规范化结果非法", ErrInvalidURL)
	}
	client := opts.HTTPClient
	if client == nil {
		client = safeClient([]string{"www.youtube.com", "youtube.com"}, 8*time.Second)
	}
	target := y.oembedBase + "/oembed?url=" + url.QueryEscape(normalizedURL) + "&format=json"
	var resp ytOEmbedResp
	if err := fetchJSON(ctx, client, target, nil, &resp); err != nil {
		if notFoundOEmbed(err) {
			return &TrackInfo{Platform: y.ID(), ExternalID: id, Playability: PlayabilityUnavailable,
				Message: "平台返回：视频不存在或已下架"}, nil
		}
		return nil, err
	}
	if resp.Title == "" {
		return &TrackInfo{Platform: y.ID(), ExternalID: id, Playability: PlayabilityUnavailable,
			Message: "平台返回：视频不存在或已下架"}, nil
	}
	return &TrackInfo{
		Platform:    y.ID(),
		ExternalID:  id,
		Title:       resp.Title,
		Artist:      resp.AuthorName,
		CoverURL:    resp.ThumbnailURL,
		DurationMs:  0,
		Playability: PlayabilityPlayable,
		Message:     "oEmbed 仅提供标题与作者；时长未知",
	}, nil
}

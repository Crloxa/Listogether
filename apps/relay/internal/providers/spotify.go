// spotify.go 识别并解析 Spotify 链接（open.spotify.com）。
// oEmbed 公开端点无需鉴权（2026-09 本机网络不可达，见 PROVIDERS.md P-001；
// 适配器保留：URL 匹配/规范化离线可用，解析失败以 PROVIDER_UNAVAILABLE 可解释返回）。
// 携带 OAuth token 时改用 Web API 获取更完整元数据（时长/艺人/市场可播性）。
package providers

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const (
	spotifyOEmbedBase = "https://open.spotify.com"
	spotifyAPIBase    = "https://api.spotify.com"
)

// Spotify 是 Spotify 适配器；端点可注入（测试/mock）。
type Spotify struct {
	oembedBase string
	apiBase    string
}

// NewSpotify 返回生产配置的适配器。
func NewSpotify() *Spotify { return &Spotify{oembedBase: spotifyOEmbedBase, apiBase: spotifyAPIBase} }

func (s *Spotify) ID() string { return PlatformSpotify }

var spotifyTrackID = regexp.MustCompile(`^[0-9A-Za-z]{22}$`)

func (s *Spotify) Match(u *url.URL) bool {
	host := strings.ToLower(u.Hostname())
	if host != "open.spotify.com" && host != "spotify.com" {
		return false
	}
	// 只接受单曲链接；专辑/歌单明确拒绝（D-014 只做单曲识别）
	return extractSpotifyTrackID(u.Path) != ""
}

// extractSpotifyTrackID 从路径提取曲目 ID（兼容 /intl-<lang>/track/<id> 与 /embed/track/<id>）。
func extractSpotifyTrackID(path string) string {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	for i, p := range parts {
		if p == "track" && i+1 < len(parts) && spotifyTrackID.MatchString(parts[i+1]) {
			return parts[i+1]
		}
	}
	return ""
}

// NormalizeURL 输出 https://open.spotify.com/track/<id>。
func (s *Spotify) NormalizeURL(raw string) (string, error) {
	u, err := parseRawURL(raw)
	if err != nil {
		return "", err
	}
	id := extractSpotifyTrackID(u.Path)
	if id == "" {
		return "", fmt.Errorf("%w: 目前只支持 Spotify 单曲链接（/track/<id>）", ErrUnsupportedPlatform)
	}
	return spotifyOEmbedBase + "/track/" + id, nil
}

type spotifyOEmbedResp struct {
	Title        string `json:"title"`
	ThumbnailURL string `json:"thumbnail_url"`
}

type spotifyAPIResp struct {
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	DurationMs int64           `json:"duration_ms"`
	Artists    []spotifyArtist `json:"artists"`
	Album      spotifyAlbum    `json:"album"`
	PreviewURL *string         `json:"preview_url"`
	IsPlayable *bool           `json:"is_playable"`
}

type spotifyArtist struct {
	Name string `json:"name"`
}

type spotifyAlbum struct {
	Name   string `json:"name"`
	Images []struct {
		URL string `json:"url"`
	} `json:"images"`
}

// Resolve：有 token 走 Web API，否则 oEmbed。网络失败一律 ErrProviderUnavailable（P-001 常态）。
func (s *Spotify) Resolve(ctx context.Context, normalizedURL string, opts ResolveOptions) (*TrackInfo, error) {
	trimmed := strings.TrimPrefix(normalizedURL, spotifyOEmbedBase)
	id := extractSpotifyTrackID(trimmed)
	if id == "" {
		return nil, fmt.Errorf("%w: 内部规范化结果非法", ErrInvalidURL)
	}
	client := opts.HTTPClient
	if client == nil {
		client = safeClient([]string{"open.spotify.com", "api.spotify.com"}, 8*time.Second)
	}
	if opts.Token != "" {
		api := s.apiBase + "/v1/tracks/" + id
		headers := map[string]string{"Authorization": "Bearer " + opts.Token}
		var resp spotifyAPIResp
		if err := fetchJSON(ctx, client, api, headers, &resp); err != nil {
			return nil, err
		}
		info := &TrackInfo{
			Platform:   s.ID(),
			ExternalID: id,
			Title:      resp.Name,
			DurationMs: resp.DurationMs,
		}
		if len(resp.Artists) > 0 {
			var names []string
			for _, a := range resp.Artists {
				names = append(names, a.Name)
			}
			info.Artist = strings.Join(names, ", ")
		}
		info.Album = resp.Album.Name
		if len(resp.Album.Images) > 0 {
			info.CoverURL = resp.Album.Images[0].URL
		}
		switch {
		case resp.IsPlayable != nil && !*resp.IsPlayable:
			info.Playability = PlayabilityUnavailable
			info.Message = "平台标注该曲目在当前账号市场不可播"
		case resp.Name != "":
			info.Playability = PlayabilityPlayable
		default:
			info.Playability = PlayabilityUnavailable
			info.Message = "平台返回的数据缺少标题"
		}
		return info, nil
	}
	target := s.oembedBase + "/oembed?url=" + url.QueryEscape(s.oembedBase+"/track/"+id) + "&format=json"
	var resp spotifyOEmbedResp
	if err := fetchJSON(ctx, client, target, nil, &resp); err != nil {
		if notFoundOEmbed(err) {
			return &TrackInfo{Platform: s.ID(), ExternalID: id, Playability: PlayabilityUnavailable,
				Message: "平台返回：歌曲不存在或已下架"}, nil
		}
		return nil, err
	}
	if resp.Title == "" {
		return &TrackInfo{Platform: s.ID(), ExternalID: id, Playability: PlayabilityUnavailable,
			Message: "平台返回：歌曲不存在或已下架"}, nil
	}
	return &TrackInfo{
		Platform:    s.ID(),
		ExternalID:  id,
		Title:       resp.Title,
		CoverURL:    resp.ThumbnailURL,
		DurationMs:  0,
		Playability: PlayabilityPlayable,
		Message:     "oEmbed 仅提供标题与封面；时长/艺人未知",
	}, nil
}

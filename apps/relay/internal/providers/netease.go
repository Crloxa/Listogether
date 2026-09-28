// netease.go 识别并解析网易云音乐链接（music.163.com）。
// 公开详情 API：GET /api/song/detail?id=<id>&ids=[<id>]（无需鉴权，2026-09 实测可用）。
// fee 字段保守映射 playability：0 免费 / 1,4 需登录或购买 / 8 仅低音质免费（预览近似）。
package providers

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	neteaseAPIBase = "https://music.163.com"
	neteaseReferer = "https://music.163.com/"
)

// NetEase 是网易云音乐适配器；apiBase 可注入（测试）。
type NetEase struct{ apiBase string }

// NewNetEase 返回生产配置的适配器。
func NewNetEase() *NetEase { return &NetEase{apiBase: neteaseAPIBase} }

func (n *NetEase) ID() string { return PlatformNetEase }

var neteaseSongID = regexp.MustCompile(`^\d{1,20}$`)

func (n *NetEase) Match(u *url.URL) bool {
	return strings.EqualFold(u.Hostname(), "music.163.com") &&
		(strings.HasPrefix(u.Path, "/song") || strings.HasPrefix(u.Path, "/outchain/"))
}

// NormalizeURL 接受 /song?id=<id> 与 /song/<id> 两种形态，输出 https://music.163.com/song?id=<id>。
func (n *NetEase) NormalizeURL(raw string) (string, error) {
	u, err := parseRawURL(raw)
	if err != nil {
		return "", err
	}
	id := u.Query().Get("id")
	if id == "" {
		// /song/<id> 与 /outchain/2:<id> 形态
		parts := strings.Split(strings.Trim(u.Path, "/"), "/")
		for i, p := range parts {
			if p == "song" && i+1 < len(parts) {
				id = parts[i+1]
			}
		}
	}
	if !neteaseSongID.MatchString(id) {
		return "", fmt.Errorf("%w: 网易云链接缺少合法的歌曲 id", ErrInvalidURL)
	}
	return neteaseAPIBase + "/song?id=" + id, nil
}

type neteaseDetailResp struct {
	Songs []neteaseSong `json:"songs"`
	Code  int           `json:"code"`
}

type neteaseSong struct {
	Name     string        `json:"name"`
	ID       int64         `json:"id"`
	Duration int64         `json:"duration"`
	Fee      int           `json:"fee"`
	Status   int           `json:"status"`
	Artists  []neteaseName `json:"artists"`
	Album    neteaseAlbum  `json:"album"`
}

type neteaseName struct {
	Name string `json:"name"`
}

type neteaseAlbum struct {
	Name   string `json:"name"`
	PicURL string `json:"picUrl"`
}

// Resolve 拉取歌曲详情；平台确认不存在时返回 unavailable 而不是错误（P-002 同理）。
func (n *NetEase) Resolve(ctx context.Context, normalizedURL string, opts ResolveOptions) (*TrackInfo, error) {
	u, err := url.Parse(normalizedURL)
	if err != nil {
		return nil, fmt.Errorf("%w: 内部规范化结果非法", ErrInvalidURL)
	}
	id := u.Query().Get("id")
	client := opts.HTTPClient
	if client == nil {
		client = safeClient([]string{"music.163.com"}, 8*time.Second)
	}
	api := fmt.Sprintf("%s/api/song/detail?id=%s&ids=%%5B%s%%5D", n.apiBase, id, id)
	var resp neteaseDetailResp
	if err := fetchJSON(ctx, client, api, map[string]string{"Referer": neteaseReferer}, &resp); err != nil {
		return nil, err
	}
	if len(resp.Songs) == 0 {
		return &TrackInfo{Platform: n.ID(), ExternalID: id, Playability: PlayabilityUnavailable,
			Message: "平台返回：歌曲不存在或已下架"}, nil
	}
	s := resp.Songs[0]
	info := &TrackInfo{
		Platform:    n.ID(),
		ExternalID:  id,
		Title:       s.Name,
		DurationMs:  s.Duration,
		Playability: PlayabilityUnknown,
	}
	if s.Album.PicURL != "" {
		info.CoverURL = s.Album.PicURL
	}
	if s.Album.Name != "" {
		info.Album = s.Album.Name
	}
	var artists []string
	for _, a := range s.Artists {
		if a.Name != "" {
			artists = append(artists, a.Name)
		}
	}
	info.Artist = strings.Join(artists, ", ")
	if info.Title == "" {
		return &TrackInfo{Platform: n.ID(), ExternalID: id, Playability: PlayabilityUnavailable,
			Message: "平台返回的数据缺少标题"}, nil
	}
	switch s.Fee {
	case 0:
		info.Playability = PlayabilityPlayable
	case 1, 4:
		info.Playability = PlayabilityNeedsLogin
		info.Message = "平台标注该曲目需登录/会员，实际可播性以平台为准"
	case 8:
		info.Playability = PlayabilityPreviewOnly
		info.Message = "平台标注该曲目仅有限免费试听"
	default:
		info.Playability = PlayabilityUnknown
		info.Message = "平台可用性标注未知（fee=" + strconv.Itoa(s.Fee) + "）"
	}
	return info, nil
}

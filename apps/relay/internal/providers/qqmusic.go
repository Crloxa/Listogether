// qqmusic.go 识别并解析 QQ 音乐链接（y.qq.com）。
// 公开单曲 API：GET c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songmid=<mid>&format=json
// 无效 songmid 返回 HTTP 200 + 空 data（P-002），必须映射为 unavailable 而非错误。
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
	qqAPIBase  = "https://c.y.qq.com"
	qqReferer  = "https://y.qq.com/"
	qqLinkBase = "https://y.qq.com"
)

// QQMusic 是 QQ 音乐适配器；apiBase 可注入（测试）。
type QQMusic struct{ apiBase string }

// NewQQMusic 返回生产配置的适配器。
func NewQQMusic() *QQMusic { return &QQMusic{apiBase: qqAPIBase} }

func (q *QQMusic) ID() string { return PlatformQQMusic }

var qqSongMid = regexp.MustCompile(`^[0-9A-Za-z]{6,20}$`)

func (q *QQMusic) Match(u *url.URL) bool {
	host := strings.ToLower(u.Hostname())
	if host != "y.qq.com" && host != "i.y.qq.com" {
		return false
	}
	return strings.Contains(u.Path, "/yqq/song") || u.Query().Get("songmid") != "" || u.Query().Get("mid") != ""
}

// NormalizeURL 输出 https://y.qq.com/n/yqq/song/<mid>.html。
func (q *QQMusic) NormalizeURL(raw string) (string, error) {
	u, err := parseRawURL(raw)
	if err != nil {
		return "", err
	}
	mid := u.Query().Get("songmid")
	if mid == "" {
		mid = u.Query().Get("mid")
	}
	if mid == "" {
		// /n/yqq/song/<mid>.html 形态
		m := regexp.MustCompile(`/yqq/song/([0-9A-Za-z]+)\.html`).FindStringSubmatch(u.Path)
		if m != nil {
			mid = m[1]
		}
	}
	if !qqSongMid.MatchString(mid) {
		return "", fmt.Errorf("%w: QQ 音乐链接缺少合法的歌曲 mid", ErrInvalidURL)
	}
	return qqLinkBase + "/n/yqq/song/" + mid + ".html", nil
}

type qqResp struct {
	Code int      `json:"code"`
	Data []qqSong `json:"data"`
}

type qqSong struct {
	Title    string   `json:"title"`
	SongName string   `json:"songname"`
	Mid      string   `json:"mid"`
	Interval int      `json:"interval"` // 秒
	Singer   []qqName `json:"singer"`
	Album    qqAlbum  `json:"album"`
	Pay      qqPay    `json:"pay"`
}

type qqName struct {
	Name string `json:"name"`
}

type qqAlbum struct {
	Name string `json:"name"`
	Mid  string `json:"mid"`
}

type qqPay struct {
	PayPlay int `json:"pay_play"`
}

// Resolve 拉取单曲信息；空 data 映射为 unavailable（P-002）。
func (q *QQMusic) Resolve(ctx context.Context, normalizedURL string, opts ResolveOptions) (*TrackInfo, error) {
	m := regexp.MustCompile(`/yqq/song/([0-9A-Za-z]+)\.html`).FindStringSubmatch(normalizedURL)
	if m == nil {
		return nil, fmt.Errorf("%w: 内部规范化结果非法", ErrInvalidURL)
	}
	mid := m[1]
	client := opts.HTTPClient
	if client == nil {
		client = safeClient([]string{"c.y.qq.com"}, 8*time.Second)
	}
	api := fmt.Sprintf("%s/v8/fcg-bin/fcg_play_single_song.fcg?songmid=%s&format=json", q.apiBase, mid)
	var resp qqResp
	if err := fetchJSON(ctx, client, api, map[string]string{"Referer": qqReferer}, &resp); err != nil {
		return nil, err
	}
	if resp.Code != 0 || len(resp.Data) == 0 {
		return &TrackInfo{Platform: q.ID(), ExternalID: mid, Playability: PlayabilityUnavailable,
			Message: "平台返回：歌曲不存在或已下架"}, nil
	}
	s := resp.Data[0]
	title := s.Title
	if title == "" {
		title = s.SongName
	}
	var artists []string
	for _, a := range s.Singer {
		if a.Name != "" {
			artists = append(artists, a.Name)
		}
	}
	info := &TrackInfo{
		Platform:    q.ID(),
		ExternalID:  mid,
		Title:       title,
		Artist:      strings.Join(artists, ", "),
		Album:       s.Album.Name,
		DurationMs:  int64(s.Interval) * 1000,
		Playability: PlayabilityUnknown,
	}
	if s.Album.Mid != "" {
		info.CoverURL = fmt.Sprintf("https://y.gtimg.cn/music/photo_new/T002R500x500M000%s.jpg", s.Album.Mid)
	}
	if info.Title == "" {
		return &TrackInfo{Platform: q.ID(), ExternalID: mid, Playability: PlayabilityUnavailable,
			Message: "平台返回的数据缺少标题"}, nil
	}
	switch {
	case s.Pay.PayPlay == 0:
		info.Playability = PlayabilityPlayable
	case s.Pay.PayPlay == 1:
		info.Playability = PlayabilityNeedsLogin
		info.Message = "平台标注该曲目需付费/会员，实际可播性以平台为准"
	default:
		info.Playability = PlayabilityUnknown
		info.Message = "平台可用性标注未知（pay_play=" + strconv.Itoa(s.Pay.PayPlay) + "）"
	}
	return info, nil
}

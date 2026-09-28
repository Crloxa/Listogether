// Package config 从环境变量读取 Relay 配置。
// 敏感配置规则：真实密钥不写入仓库文件（.env.example 只放占位值）；
// TLS 证书路径不是敏感值本身，但私钥文件权限需由部署方保证。
package config

import (
	"strconv"
	"strings"
	"time"
)

const (
	DefaultAddr          = ":8080"
	DefaultLogLevel      = "info"
	DefaultAllowedOrigin = "http://localhost:5173,http://127.0.0.1:5173"
	DefaultMaxMembers    = 16
	MaxMembersCap        = 256

	DefaultOfflineTTL = 45 * time.Second
	MinOfflineTTL     = 5 * time.Second
)

// Config 是 Relay 的启动配置；字段均为非敏感值。
type Config struct {
	Addr           string
	LogLevel       string
	AllowedOrigins []string
	// TLSCertFile/TLSKeyFile 非空时以 HTTPS/WSS 直连模式启动。
	TLSCertFile string
	TLSKeyFile  string
	// MaxMembers 是未显式指定人数上限时新建房间的默认值。
	MaxMembers int
	// OfflineTTL 是成员断线后被移除前的宽限期。
	OfflineTTL time.Duration
	// PublicBaseURL 是 Relay 对外可达基址（OAuth 回调 redirect_uri 用）；空则 OAuth 不可用。
	PublicBaseURL string
	// TURN 短期凭据（D-018）：URLs 与 Secret 齐备时 /api/webrtc/ice 下发 coturn REST 凭据。
	TurnURLs   []string
	TurnSecret string
	TurnTTL    time.Duration
	// 平台 API base 覆盖（D-019）：接口变更时运维侧应急切换，不改代码；空用内置默认。
	NetEaseAPIBase    string
	QQMusicAPIBase    string
	SpotifyOEmbedBase string
	SpotifyAPIBase    string
	YouTubeOEmbedBase string
}

// FromEnv 按键读取环境变量；getenv 便于测试注入。
func FromEnv(getenv func(string) string) Config {
	addr := firstNonEmpty(getenv("LISTO_RELAY_ADDR"), DefaultAddr)
	level := strings.ToLower(firstNonEmpty(getenv("LISTO_RELAY_LOG_LEVEL"), DefaultLogLevel))
	origins := splitOrigins(firstNonEmpty(getenv("LISTO_RELAY_ALLOWED_ORIGINS"), DefaultAllowedOrigin))
	maxMembers := parseInt(getenv("LISTO_RELAY_MAX_MEMBERS"), DefaultMaxMembers)
	if maxMembers < 2 {
		maxMembers = 2
	}
	if maxMembers > MaxMembersCap {
		maxMembers = MaxMembersCap
	}
	offlineTTL := time.Duration(parseInt(getenv("LISTO_RELAY_OFFLINE_TTL_SECONDS"), int(DefaultOfflineTTL/time.Second))) * time.Second
	if offlineTTL < MinOfflineTTL {
		offlineTTL = MinOfflineTTL
	}
	turnTTL := time.Duration(parseInt(getenv("LISTO_TURN_TTL_SECONDS"), 3600)) * time.Second
	return Config{
		Addr:              addr,
		LogLevel:          level,
		AllowedOrigins:    origins,
		TLSCertFile:       strings.TrimSpace(getenv("LISTO_RELAY_TLS_CERT")),
		TLSKeyFile:        strings.TrimSpace(getenv("LISTO_RELAY_TLS_KEY")),
		MaxMembers:        maxMembers,
		OfflineTTL:        offlineTTL,
		PublicBaseURL:     strings.TrimRight(strings.TrimSpace(getenv("LISTO_RELAY_PUBLIC_BASE_URL")), "/"),
		TurnURLs:          splitOrigins(getenv("LISTO_TURN_URLS")),
		TurnSecret:        strings.TrimSpace(getenv("LISTO_TURN_SECRET")),
		TurnTTL:           turnTTL,
		NetEaseAPIBase:    strings.TrimSpace(getenv("LISTO_PROVIDERS_NETEASE_API_BASE")),
		QQMusicAPIBase:    strings.TrimSpace(getenv("LISTO_PROVIDERS_QQMUSIC_API_BASE")),
		SpotifyOEmbedBase: strings.TrimSpace(getenv("LISTO_PROVIDERS_SPOTIFY_OEMBED_BASE")),
		SpotifyAPIBase:    strings.TrimSpace(getenv("LISTO_PROVIDERS_SPOTIFY_API_BASE")),
		YouTubeOEmbedBase: strings.TrimSpace(getenv("LISTO_PROVIDERS_YOUTUBE_OEMBED_BASE")),
	}
}

// TLS 是否启用直连 TLS 模式。
func (c Config) TLS() bool { return c.TLSCertFile != "" && c.TLSKeyFile != "" }

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func parseInt(raw string, fallback int) int {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return n
}

func splitOrigins(raw string) []string {
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if v := strings.TrimSpace(p); v != "" {
			out = append(out, v)
		}
	}
	return out
}

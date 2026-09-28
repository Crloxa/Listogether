// Package turncreds 按 coturn use-auth-secret 的 REST 凭据机制（draft-uberti-rtcweb-turn-rest）
// 生成短期 TURN 凭据：username = 过期 Unix 秒，credential = base64(SHA1-HMAC(secret, username))。
//
// 算法约束（安全审查说明）：HMAC-SHA1 是该协议的规范要求——coturn 的 use-auth-secret
// 以完全相同的算法从 username 重算凭据，改用其他哈希将无法与任何标准 coturn 部署互通。
// 风险由三重缓解：(1) HMAC-SHA1 目前无已知实际碰撞攻击；(2) 凭据内容是短期过期时间戳，
// 泄露窗口 = TTL（默认 1h，上限 24h）；(3) secret 本身建议 ≥32 字节高熵值。
// 与 coturn 参考实现一致；测试向量由独立实现（node crypto）预先计算，避免循环验证。
package turncreds

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"strconv"
	"time"
)

// IceServer 是下发给浏览器的单条 TURN/STUN 配置（RTCIceServer 子集）。
type IceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// TTLBounds 是允许的凭据有效期范围：过短会造成频繁刷新，过长等于长期凭据。
const (
	MinTTL = 5 * time.Minute
	MaxTTL = 24 * time.Hour
)

// Generate 为给定 URL 列表生成一组共享同一短期凭据的 ICE 服务器。
// urls 为空返回错误；secret 为空返回错误（无凭据的 TURN 配置没有意义）。
func Generate(secret string, urls []string, ttl time.Duration, now time.Time) ([]IceServer, error) {
	if secret == "" {
		return nil, fmt.Errorf("turn secret 为空")
	}
	if len(urls) == 0 {
		return nil, fmt.Errorf("turn urls 为空")
	}
	if ttl < MinTTL {
		ttl = MinTTL
	}
	if ttl > MaxTTL {
		ttl = MaxTTL
	}
	username := strconv.FormatInt(now.Add(ttl).Unix(), 10)
	mac := hmac.New(sha1.New, []byte(secret))
	_, err := mac.Write([]byte(username))
	if err != nil {
		return nil, fmt.Errorf("hmac 写入失败: %w", err)
	}
	credential := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	return []IceServer{{
		URLs:       append([]string(nil), urls...),
		Username:   username,
		Credential: credential,
	}}, nil
}

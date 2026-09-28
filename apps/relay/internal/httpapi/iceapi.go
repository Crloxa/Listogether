// iceapi.go：WebRTC ICE 配置端点（D-018）。
// 会话鉴权后下发 TURN 短期凭据（coturn REST 机制）或默认 STUN；
// secret 不出本包，凭据只在响应中出现一次。
package httpapi

import (
	"log/slog"
	"net/http"
	"time"

	"listogether/apps/relay/internal/hub"
	"listogether/apps/relay/internal/protocol"
	"listogether/apps/relay/internal/turncreds"
)

// DefaultSTUNServers 与 web 端 DEFAULT_ICE_SERVERS 保持一致。
var DefaultSTUNServers = []turncreds.IceServer{{URLs: []string{"stun:stun.l.google.com:19302"}}}

// NewICEAPI 返回挂载在 GET /api/webrtc/ice 的处理器（自带会话鉴权）。
func NewICEAPI(logger *slog.Logger, h *hub.Hub, turnURLs []string, turnSecret string, turnTTL time.Duration, now func() time.Time) http.Handler {
	if now == nil {
		now = time.Now
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sessionToken := bearerToken(r)
		if sessionToken == "" {
			writeJSON(w, http.StatusUnauthorized, errorBody{Code: protocol.CodeInvalidToken, Message: "缺少会话凭证"})
			return
		}
		if _, ok := h.LookupSession(sessionToken); !ok {
			writeJSON(w, http.StatusUnauthorized, errorBody{Code: protocol.CodeInvalidToken, Message: "会话已失效，请重新加入"})
			return
		}
		var servers []turncreds.IceServer
		turnEnabled := len(turnURLs) > 0 && turnSecret != ""
		if turnEnabled {
			generated, err := turncreds.Generate(turnSecret, turnURLs, turnTTL, now())
			if err != nil {
				logger.Error("turn credential generation failed", "err", err.Error())
				writeJSON(w, http.StatusInternalServerError, errorBody{Code: "INTERNAL", Message: "TURN 凭据生成失败"})
				return
			}
			servers = generated
		} else {
			servers = DefaultSTUNServers
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"iceServers":  servers,
			"turnEnabled": turnEnabled,
			"ttlSeconds":  int(turnTTL / time.Second),
		})
	})
}

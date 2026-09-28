// resolveapi.go：平台链接解析端点（Phase 4，D-014）。
// 仅房主可用 + 限流 10 次/分钟/成员；SSRF 防护由 providers 包的安全客户端承担。
package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"listogether/apps/relay/internal/auth"
	"listogether/apps/relay/internal/hub"
	"listogether/apps/relay/internal/oauth"
	"listogether/apps/relay/internal/protocol"
	"listogether/apps/relay/internal/providers"
	"listogether/apps/relay/internal/room"
)

const (
	resolveRateLimit  = 10
	resolveRateWindow = time.Minute
)

// ResolveAPI 挂载在 /api/rooms/{roomId}/links/resolve。
type ResolveAPI struct {
	logger   *slog.Logger
	hub      *hub.Hub
	registry *providers.Registry
	oauthMgr *oauth.Manager

	mu       sync.Mutex
	attempts map[string][]time.Time // memberKey → 窗口内请求时刻
}

func NewResolveAPI(logger *slog.Logger, h *hub.Hub, reg *providers.Registry, om *oauth.Manager) *ResolveAPI {
	return &ResolveAPI{logger: logger, hub: h, registry: reg, oauthMgr: om, attempts: map[string][]time.Time{}}
}

// ServeHTTP 处理 POST /api/rooms/{roomId}/links/resolve。
func (a *ResolveAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	sessionToken := bearerToken(r)
	if sessionToken == "" {
		writeJSON(w, http.StatusUnauthorized, errorBody{Code: protocol.CodeInvalidToken, Message: "缺少会话凭证"})
		return
	}
	session, ok := a.hub.LookupSession(sessionToken)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errorBody{Code: protocol.CodeInvalidToken, Message: "会话已失效，请重新加入"})
		return
	}
	roomID := r.PathValue("roomId")
	if session.RoomID != roomID {
		writeJSON(w, http.StatusForbidden, errorBody{Code: protocol.CodeUnauthorized, Message: "会话不属于该房间"})
		return
	}
	roomRef, ok := a.hub.Room(roomID)
	if !ok {
		writeError(w, &hub.Error{Code: protocol.CodeRoomNotFound, Message: "房间不存在或已关闭"})
		return
	}
	if role := roomRef.RoleOf(session.MemberID); role != room.RoleHost {
		writeJSON(w, http.StatusForbidden, errorBody{Code: protocol.CodeUnauthorized, Message: "只有房主可以解析平台链接"})
		return
	}
	memberKey := auth.HashToken(sessionToken)
	if !a.allow(memberKey) {
		writeJSON(w, http.StatusTooManyRequests, errorBody{Code: protocol.CodeRateLimited, Message: "解析太频繁，请稍后再试（10 次/分钟）"})
		return
	}
	var body struct {
		URL string `json:"url"`
	}
	if !readJSON(w, r, &body) || body.URL == "" {
		writeJSON(w, http.StatusBadRequest, errorBody{Code: protocol.CodeInvalidMessage, Message: "缺少 url 字段"})
		return
	}

	// 已连接平台账号时携带 token（provider 自行决定是否使用；token 不出本进程）
	opts := providers.ResolveOptions{}
	if a.oauthMgr != nil {
		if p, _, findErr := a.registry.Find(body.URL); findErr == nil {
			if tok, tokErr := a.oauthMgr.AccessToken(p.ID(), memberKey); tokErr == nil {
				opts.Token = tok
			}
		}
	}
	info, normalized, err := a.registry.Resolve(r.Context(), body.URL, opts)
	if err != nil {
		a.logger.Info("link resolve failed", "reason", err.Error())
		writeResolveError(w, err)
		return
	}
	resp := struct {
		*providers.TrackInfo
		NormalizedURL string `json:"normalizedUrl"`
	}{info, normalized}
	writeJSON(w, http.StatusOK, resp)
}

// allow 滑动窗口限流（10 次/分钟/成员）。
func (a *ResolveAPI) allow(memberKey string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := time.Now()
	recent := a.attempts[memberKey][:0]
	for _, t := range a.attempts[memberKey] {
		if now.Sub(t) < resolveRateWindow {
			recent = append(recent, t)
		}
	}
	if len(recent) >= resolveRateLimit {
		a.attempts[memberKey] = recent
		return false
	}
	a.attempts[memberKey] = append(recent, now)
	return true
}

func writeResolveError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, providers.ErrUnsupportedPlatform):
		writeJSON(w, http.StatusBadRequest, errorBody{Code: "PLATFORM_UNSUPPORTED", Message: err.Error()})
	case errors.Is(err, providers.ErrInvalidURL):
		writeJSON(w, http.StatusBadRequest, errorBody{Code: protocol.CodeInvalidMessage, Message: err.Error()})
	case errors.Is(err, providers.ErrProviderUnavailable):
		// 平台不可达是环境性失败：502 + 可解释原因（含根因，如超时/HTTP 状态）
		writeJSON(w, http.StatusBadGateway, errorBody{Code: "PROVIDER_UNAVAILABLE", Message: err.Error()})
	default:
		writeJSON(w, http.StatusBadGateway, errorBody{Code: "PROVIDER_UNAVAILABLE", Message: "平台解析失败"})
	}
}

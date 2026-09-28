// oauthapi.go：OAuth 浏览器端点（Phase 4，D-015）。
// token 只在 oauth.Manager 内存中；本文件仅输出连接状态与打码用户标识。
package httpapi

import (
	"errors"
	"html/template"
	"log/slog"
	"net/http"

	"listogether/apps/relay/internal/auth"
	"listogether/apps/relay/internal/hub"
	"listogether/apps/relay/internal/oauth"
	"listogether/apps/relay/internal/protocol"
)

// NewOAuthAPI 返回挂载在 /api/oauth 前缀下的处理器。
func NewOAuthAPI(logger *slog.Logger, h *hub.Hub, mgr *oauth.Manager, allowedOrigins []string) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /api/oauth/providers", requireSession(logger, h, handleOAuthProviders(mgr)))
	mux.Handle("POST /api/oauth/{provider}/start", requireSession(logger, h, handleOAuthStart(mgr)))
	mux.Handle("GET /api/oauth/{provider}/callback", handleOAuthCallback(mgr))
	mux.Handle("POST /api/oauth/{provider}/disconnect", requireSession(logger, h, handleOAuthDisconnect(mgr)))
	return WithRoomCORS(allowedOrigins, mux)
}

func handleOAuthProviders(mgr *oauth.Manager) sessionHandler {
	return func(w http.ResponseWriter, r *http.Request, _ hub.Session, _ string) {
		memberKey := auth.HashToken(bearerToken(r))
		statuses := make([]oauth.ProviderStatus, 0, len(oauth.KnownProviderIDs))
		for _, id := range oauth.KnownProviderIDs {
			statuses = append(statuses, mgr.Status(id, memberKey))
		}
		writeJSON(w, http.StatusOK, map[string]any{"providers": statuses})
	}
}

func handleOAuthStart(mgr *oauth.Manager) sessionHandler {
	return func(w http.ResponseWriter, r *http.Request, _ hub.Session, _ string) {
		memberKey := auth.HashToken(bearerToken(r))
		providerID := r.PathValue("provider")
		authorizeURL, err := mgr.Start(providerID, memberKey)
		if err != nil {
			writeOAuthError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"authorizeUrl": authorizeURL})
	}
}

func handleOAuthCallback(mgr *oauth.Manager) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		providerID := r.PathValue("provider")
		q := r.URL.Query()
		err := mgr.HandleCallback(providerID, q.Get("code"), q.Get("state"), q.Get("error"))
		if err != nil {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusBadRequest)
			_ = callbackErrorTemplate.Execute(w, map[string]string{
				"Reason": template.HTMLEscapeString(err.Error()),
			})
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_ = callbackOKTemplate.Execute(w, nil)
	})
}

func handleOAuthDisconnect(mgr *oauth.Manager) sessionHandler {
	return func(w http.ResponseWriter, r *http.Request, _ hub.Session, _ string) {
		memberKey := auth.HashToken(bearerToken(r))
		if err := mgr.Disconnect(r.PathValue("provider"), memberKey); err != nil {
			writeOAuthError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"disconnected": true})
	}
}

func writeOAuthError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, oauth.ErrNotConfigured):
		writeJSON(w, http.StatusServiceUnavailable, errorBody{Code: "OAUTH_NOT_CONFIGURED", Message: err.Error()})
	case errors.Is(err, oauth.ErrUnknownProvider):
		writeJSON(w, http.StatusNotFound, errorBody{Code: protocol.CodeInvalidMessage, Message: err.Error()})
	case errors.Is(err, oauth.ErrDenied):
		writeJSON(w, http.StatusBadRequest, errorBody{Code: "OAUTH_DENIED", Message: err.Error()})
	case errors.Is(err, oauth.ErrUnknownState):
		writeJSON(w, http.StatusBadRequest, errorBody{Code: "OAUTH_STATE_MISMATCH", Message: "授权状态校验失败，请重新发起"})
	case errors.Is(err, oauth.ErrProviderError):
		writeJSON(w, http.StatusBadGateway, errorBody{Code: "PROVIDER_UNAVAILABLE", Message: err.Error()})
	default:
		writeJSON(w, http.StatusInternalServerError, errorBody{Code: protocol.CodeInternal, Message: "内部错误"})
	}
}

// 回调页是浏览器顶层导航：静态模板 + HTML 转义，避免 provider 侧参数注入。
var callbackOKTemplate = template.Must(template.New("ok").Parse(`<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><title>授权完成</title>
<body style="font-family:system-ui;text-align:center;padding-top:4rem">
<h1>授权完成</h1><p>请回到房间标签页，连接状态会在几秒内更新。</p>
<script>try{window.close()}catch(e){}</script>
</body></html>`))

var callbackErrorTemplate = template.Must(template.New("err").Parse(`<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><title>授权未完成</title>
<body style="font-family:system-ui;text-align:center;padding-top:4rem">
<h1>授权未完成</h1><p>原因：{{.Reason}}</p><p>请回到房间标签页重试，或改用不登录继续使用。</p>
</body></html>`))

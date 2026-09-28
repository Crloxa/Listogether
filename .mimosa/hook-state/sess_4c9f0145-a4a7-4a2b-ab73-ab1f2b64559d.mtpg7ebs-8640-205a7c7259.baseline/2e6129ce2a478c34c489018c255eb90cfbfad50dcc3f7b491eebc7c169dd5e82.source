// Package httpapi 提供 Relay 的 HTTP 端点（healthz）与 CORS 中间件。
package httpapi

import (
	"encoding/json"
	"net/http"
	"time"
)

// Version 是 Relay 服务版本号。
const Version = "0.0.1"

// HealthResponse 是 /healthz 的响应体。
type HealthResponse struct {
	Status  string `json:"status"`
	Service string `json:"service"`
	Version string `json:"version"`
	TimeMs  int64  `json:"timeMs"`
}

// NewHealthHandler 返回 GET /healthz 处理器。
func NewHealthHandler(allowedOrigins []string) http.Handler {
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(HealthResponse{
			Status:  "ok",
			Service: "listogether-relay",
			Version: Version,
			TimeMs:  time.Now().UnixMilli(),
		})
	})
	return WithCORS(allowedOrigins, h)
}

// WithCORS 对白名单来源回显 Access-Control-Allow-Origin，并处理预检请求。
func WithCORS(allowedOrigins []string, next http.Handler) http.Handler {
	allowed := make(map[string]struct{}, len(allowedOrigins))
	for _, o := range allowedOrigins {
		allowed[o] = struct{}{}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			if _, ok := allowed[origin]; ok {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Add("Vary", "Origin")
			}
			if r.Method == http.MethodOptions {
				w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

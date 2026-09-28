// recover.go：HTTP panic recovery（Phase 4 加固）。
// handler 内任何 panic 都不会击穿 http.Server：记录脱敏日志并回 500。
package httpapi

import (
	"log/slog"
	"net/http"
	"runtime/debug"
)

// WithRecovery 包装处理器：捕获 panic 并返回 500。
func WithRecovery(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				// 只记录 panic 值与调用栈；URL/query 不进日志（D-008：可能含凭证）
				logger.Error("http handler panic recovered",
					"panic", sanitizePanicValue(rec),
					"method", r.Method,
					"stack", string(debug.Stack()),
				)
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
				w.WriteHeader(http.StatusInternalServerError)
				_, _ = w.Write([]byte(`{"code":"INTERNAL","message":"服务器内部错误"}`))
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func sanitizePanicValue(rec any) string {
	if err, ok := rec.(error); ok {
		return err.Error()
	}
	if s, ok := rec.(string); ok {
		return s
	}
	return "unknown panic value"
}

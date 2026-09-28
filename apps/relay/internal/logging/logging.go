// Package logging 提供带敏感字段脱敏的结构化日志。
package logging

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strings"
)

// RedactedValue 是敏感字段被遮蔽后的占位值。
const RedactedValue = "<REDACTED>"

// sensitiveKeys 与 packages/shared/src/redact.ts 的 SENSITIVE_KEYS 保持同步；
// 新增键时两侧都要改。
var sensitiveKeys = map[string]struct{}{
	"token":         {},
	"access_token":  {},
	"refresh_token": {},
	"password":      {},
	"passwd":        {},
	"cookie":        {},
	"authorization": {},
	"secret":        {},
	"filepath":      {},
	"localpath":     {},
	"audiopath":     {},
}

// IsSensitiveKey 判断日志键是否敏感；大小写不敏感，组前缀取最后一个 `.` 之后的段。
func IsSensitiveKey(key string) bool {
	if i := strings.LastIndex(key, "."); i >= 0 {
		key = key[i+1:]
	}
	_, ok := sensitiveKeys[strings.ToLower(key)]
	return ok
}

// New 返回写 stdout 的 JSON 日志。
func New(level string) *slog.Logger {
	return NewWithWriter(level, os.Stdout)
}

// NewWithWriter 返回写指定 writer 的 JSON 日志，测试用。
func NewWithWriter(level string, w io.Writer) *slog.Logger {
	return slog.New(&redactingHandler{inner: slog.NewJSONHandler(w, &slog.HandlerOptions{Level: ParseLevel(level)})})
}

// ParseLevel 解析日志级别；未知值回退到 info。
func ParseLevel(s string) slog.Level {
	switch s {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

type redactingHandler struct {
	inner slog.Handler
}

func (h *redactingHandler) Enabled(ctx context.Context, l slog.Level) bool {
	return h.inner.Enabled(ctx, l)
}

func (h *redactingHandler) Handle(ctx context.Context, r slog.Record) error {
	clean := slog.NewRecord(r.Time, r.Level, r.Message, r.PC)
	r.Attrs(func(a slog.Attr) bool {
		clean.AddAttrs(redactAttr(a))
		return true
	})
	return h.inner.Handle(ctx, clean)
}

func (h *redactingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	cleaned := make([]slog.Attr, 0, len(attrs))
	for _, a := range attrs {
		cleaned = append(cleaned, redactAttr(a))
	}
	return &redactingHandler{inner: h.inner.WithAttrs(cleaned)}
}

func (h *redactingHandler) WithGroup(name string) slog.Handler {
	return &redactingHandler{inner: h.inner.WithGroup(name)}
}

func redactAttr(a slog.Attr) slog.Attr {
	if a.Value.Kind() == slog.KindGroup {
		group := a.Value.Group()
		cleaned := make([]slog.Attr, 0, len(group))
		for _, ga := range group {
			cleaned = append(cleaned, redactAttr(ga))
		}
		return slog.Attr{Key: a.Key, Value: slog.GroupValue(cleaned...)}
	}
	if IsSensitiveKey(a.Key) {
		return slog.String(a.Key, RedactedValue)
	}
	return a
}

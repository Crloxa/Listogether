package logging

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
)

func TestRedactsSensitiveAttrs(t *testing.T) {
	var buf bytes.Buffer
	logger := NewWithWriter("debug", &buf)
	logger.Info("member action", "token", "real-token-value", "memberId", "m-1", "count", 2)

	out := buf.String()
	if strings.Contains(out, "real-token-value") {
		t.Fatalf("log leaked token value: %s", out)
	}
	if !strings.Contains(out, RedactedValue) {
		t.Fatalf("log should contain %s: %s", RedactedValue, out)
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("log is not valid JSON: %v\n%s", err, out)
	}
	if parsed["token"] != RedactedValue {
		t.Fatalf("token = %v, want %s", parsed["token"], RedactedValue)
	}
	if parsed["memberId"] != "m-1" || parsed["count"] != float64(2) {
		t.Fatalf("non-sensitive fields should be preserved: %s", out)
	}
}

func TestRedactsGroupedAttrs(t *testing.T) {
	var buf bytes.Buffer
	logger := NewWithWriter("info", &buf).WithGroup("auth")
	logger.Info("login attempt", "refresh_token", "rt-123", "scheme", "Bearer")

	out := buf.String()
	if strings.Contains(out, "rt-123") {
		t.Fatalf("log leaked refresh_token inside group: %s", out)
	}
	if !strings.Contains(out, `"scheme":"Bearer"`) {
		t.Fatalf("non-sensitive group field should be preserved: %s", out)
	}
}

func TestIsSensitiveKey(t *testing.T) {
	cases := map[string]bool{
		"TOKEN":         true,
		"auth.token":    true,
		"accessToken":   false, // 驼峰键不属于约定键名，前端用 snake_case 记录
		"filepath":      true,
		"memberId":      false,
		"Authorization": true,
	}
	for key, want := range cases {
		if got := IsSensitiveKey(key); got != want {
			t.Fatalf("IsSensitiveKey(%q) = %v, want %v", key, got, want)
		}
	}
}

func TestParseLevelFallback(t *testing.T) {
	if ParseLevel("verbose") != slog.LevelInfo {
		t.Fatal("unknown level should fall back to info")
	}
	if ParseLevel("warn") != slog.LevelWarn {
		t.Fatal("warn should parse")
	}
}

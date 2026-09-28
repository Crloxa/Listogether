package config

import (
	"testing"
	"time"
)

func TestFromEnvDefaults(t *testing.T) {
	cfg := FromEnv(func(string) string { return "" })
	if cfg.Addr != ":8080" {
		t.Fatalf("Addr = %q, want :8080", cfg.Addr)
	}
	if cfg.LogLevel != "info" {
		t.Fatalf("LogLevel = %q, want info", cfg.LogLevel)
	}
	if cfg.MaxMembers != DefaultMaxMembers {
		t.Fatalf("MaxMembers = %d, want %d", cfg.MaxMembers, DefaultMaxMembers)
	}
	if cfg.OfflineTTL != DefaultOfflineTTL {
		t.Fatalf("OfflineTTL = %v, want %v", cfg.OfflineTTL, DefaultOfflineTTL)
	}
	if cfg.TLS() {
		t.Fatal("默认不应启用 TLS")
	}
	want := []string{"http://localhost:5173", "http://127.0.0.1:5173"}
	if len(cfg.AllowedOrigins) != len(want) {
		t.Fatalf("AllowedOrigins = %v, want %v", cfg.AllowedOrigins, want)
	}
	for i := range want {
		if cfg.AllowedOrigins[i] != want[i] {
			t.Fatalf("AllowedOrigins[%d] = %q, want %q", i, cfg.AllowedOrigins[i], want[i])
		}
	}
}

func TestFromEnvCustom(t *testing.T) {
	env := map[string]string{
		"LISTO_RELAY_ADDR":                "127.0.0.1:9000 ",
		"LISTO_RELAY_LOG_LEVEL":           "DEBUG",
		"LISTO_RELAY_ALLOWED_ORIGINS":     " https://a.example , https://b.example ,,",
		"LISTO_RELAY_MAX_MEMBERS":         "500",
		"LISTO_RELAY_OFFLINE_TTL_SECONDS": "10",
		"LISTO_RELAY_TLS_CERT":            "/tmp/cert.pem",
		"LISTO_RELAY_TLS_KEY":             "/tmp/key.pem",
	}
	cfg := FromEnv(func(key string) string { return env[key] })
	if cfg.Addr != "127.0.0.1:9000" {
		t.Fatalf("Addr = %q, want 127.0.0.1:9000", cfg.Addr)
	}
	if cfg.LogLevel != "debug" {
		t.Fatalf("LogLevel = %q, want debug", cfg.LogLevel)
	}
	if len(cfg.AllowedOrigins) != 2 || cfg.AllowedOrigins[0] != "https://a.example" || cfg.AllowedOrigins[1] != "https://b.example" {
		t.Fatalf("AllowedOrigins = %v, want trimmed two entries", cfg.AllowedOrigins)
	}
	if cfg.MaxMembers != MaxMembersCap {
		t.Fatalf("MaxMembers 超上限时应钳制为 %d, got %d", MaxMembersCap, cfg.MaxMembers)
	}
	if cfg.OfflineTTL != 10*time.Second {
		t.Fatalf("OfflineTTL = %v, want 10s", cfg.OfflineTTL)
	}
	if !cfg.TLS() {
		t.Fatal("提供证书与私钥后应启用 TLS")
	}
}

func TestFromEnvInvalidNumbersFallBack(t *testing.T) {
	env := map[string]string{
		"LISTO_RELAY_MAX_MEMBERS":         "abc",
		"LISTO_RELAY_OFFLINE_TTL_SECONDS": "-3",
	}
	cfg := FromEnv(func(key string) string { return env[key] })
	if cfg.MaxMembers != DefaultMaxMembers {
		t.Fatalf("MaxMembers = %d, want 默认 %d", cfg.MaxMembers, DefaultMaxMembers)
	}
	if cfg.OfflineTTL != MinOfflineTTL {
		t.Fatalf("OfflineTTL 低于下限应钳制为 %v, got %v", MinOfflineTTL, cfg.OfflineTTL)
	}
}

func TestFromEnvEmptyValueFallsBackToDefault(t *testing.T) {
	cfg := FromEnv(func(key string) string { return "  " })
	if cfg.Addr != DefaultAddr || cfg.LogLevel != DefaultLogLevel {
		t.Fatalf("blank env values should fall back to defaults, got %+v", cfg)
	}
}

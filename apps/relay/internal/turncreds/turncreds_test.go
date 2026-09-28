// turncreds_test.go：coturn REST 凭据算法正确性（独立向量）与 TTL 边界。
package turncreds

import (
	"testing"
	"time"
)

// 期望值由独立实现（node crypto.createHmac('sha1', secret).update(username).digest('base64')）预先计算。
func TestGenerateKnownVector(t *testing.T) {
	// username = 1736000000（固定"当前时间 + 3600s"的 now 注入）
	now := time.Unix(1735996400, 0)
	servers, err := Generate("listogether-test-secret", []string{"turn:turn.example.com:3478?transport=udp"}, time.Hour, now)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if len(servers) != 1 {
		t.Fatalf("expect 1 server, got %d", len(servers))
	}
	s := servers[0]
	if s.Username != "1736000000" {
		t.Fatalf("username = %s, want 1736000000", s.Username)
	}
	if s.Credential != "owktllEOJ1LdlY0srw8HOtlgo6c=" {
		t.Fatalf("credential = %s, want coturn 参考算法输出", s.Credential)
	}
	if s.URLs[0] != "turn:turn.example.com:3478?transport=udp" {
		t.Fatalf("urls = %v", s.URLs)
	}
}

func TestGenerateTTLBounds(t *testing.T) {
	now := time.Unix(1700000000, 0)
	// 过短 → 提升到 MinTTL
	s, err := Generate("sec", []string{"turn:x"}, time.Second, now)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := s[0].Username, "1700000300"; got != want { // 300s = MinTTL
		t.Fatalf("MinTTL username = %s, want %s", got, want)
	}
	// 过长 → 收敛到 MaxTTL
	s, err = Generate("sec", []string{"turn:x"}, 100*24*time.Hour, now)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := s[0].Username, "1700086400"; got != want { // +24h = 1700000000 + 86400
		t.Fatalf("MaxTTL username = %s, want %s", got, want)
	}
}

func TestGenerateRejectsEmpty(t *testing.T) {
	if _, err := Generate("", []string{"turn:x"}, time.Hour, time.Now()); err == nil {
		t.Fatal("空 secret 应拒绝")
	}
	if _, err := Generate("sec", nil, time.Hour, time.Now()); err == nil {
		t.Fatal("空 urls 应拒绝")
	}
}

package auth

import (
	"strings"
	"testing"
)

func TestNewTokenLengthAndUniqueness(t *testing.T) {
	seen := make(map[string]struct{})
	for i := 0; i < 100; i++ {
		token, err := NewToken()
		if err != nil {
			t.Fatalf("NewToken: %v", err)
		}
		if len(token) != TokenBytes*2 {
			t.Fatalf("token 长度 = %d, want %d", len(token), TokenBytes*2)
		}
		if _, dup := seen[token]; dup {
			t.Fatalf("token 重复: %s", token)
		}
		seen[token] = struct{}{}
	}
}

func TestHashTokenDeterministic(t *testing.T) {
	token := "abc123"
	h1 := HashToken(token)
	h2 := HashToken(token)
	if h1 != h2 {
		t.Fatalf("同 token 哈希不一致: %s vs %s", h1, h2)
	}
	if len(h1) != 64 {
		t.Fatalf("哈希长度 = %d, want 64 (sha256 hex)", len(h1))
	}
	if HashToken("other") == h1 {
		t.Fatal("不同 token 哈希不应相同")
	}
}

func TestEqualTokensConstantTime(t *testing.T) {
	if !EqualTokens(HashToken("a"), HashToken("a")) {
		t.Fatal("相同 token 哈希应相等")
	}
	if EqualTokens(HashToken("a"), HashToken("b")) {
		t.Fatal("不同 token 哈希不应相等")
	}
}

func TestPasswordHashAndVerify(t *testing.T) {
	stored, err := HashPassword("s3cret-房密码")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if !VerifyPassword("s3cret-房密码", stored) {
		t.Fatal("正确密码应通过校验")
	}
	if VerifyPassword("wrong", stored) {
		t.Fatal("错误密码不应通过校验")
	}
	if strings.Contains(stored, "s3cret") {
		t.Fatalf("存储哈希不应包含密码原文: %s", stored)
	}
	// 两次哈希盐不同
	stored2, _ := HashPassword("s3cret-房密码")
	if stored2 == stored {
		t.Fatal("同密码两次哈希应不同（随机盐）")
	}
}

func TestVerifyPasswordRejectsMalformedStored(t *testing.T) {
	for _, bad := range []string{"", "plaintext", "pbkdf2-sha256$abc$zz$00", "pbkdf2-sha256$0$aabb$ccee", "md5$100$aabb$ccee"} {
		if VerifyPassword("x", bad) {
			t.Fatalf("非法存储格式应返回 false: %q", bad)
		}
	}
}

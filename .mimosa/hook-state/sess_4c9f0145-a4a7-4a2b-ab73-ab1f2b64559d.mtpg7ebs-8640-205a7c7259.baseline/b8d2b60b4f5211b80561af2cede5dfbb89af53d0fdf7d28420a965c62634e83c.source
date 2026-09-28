// Package auth 生成与校验房间凭证：邀请/会话 token（SHA-256 哈希存储）
// 和可选房间密码（PBKDF2-HMAC-SHA256）。token 原文只在创建响应中出现一次。
package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// TokenBytes 是邀请/会话 token 的随机字节数（128 位）。
const TokenBytes = 16

// passwordParams 是 PBKDF2 参数；格式版本化便于未来升级。
const (
	pbkdf2Iterations = 120000
	saltBytes        = 16
	keyBytes         = 32
	passwordFormat   = "pbkdf2-sha256"
)

// ErrRandFailure 表示系统随机源不可用；调用方应回 500 而不是降级。
var ErrRandFailure = errors.New("crypto/rand 不可用")

// NewToken 生成 128 位随机十六进制 token；随机源失败返回错误，不允许弱降级。
func NewToken() (string, error) {
	b := make([]byte, TokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("%w: %v", ErrRandFailure, err)
	}
	return hex.EncodeToString(b), nil
}

// HashToken 计算 token 的 SHA-256 哈希（hex）；Relay 只保存哈希。
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// EqualTokens 以常量时间比较两个 token 哈希。
func EqualTokens(hashA, hashB string) bool {
	return subtle.ConstantTimeCompare([]byte(hashA), []byte(hashB)) == 1
}

// HashPassword 用 PBKDF2-HMAC-SHA256 加盐哈希房间密码。
// 输出格式：pbkdf2-sha256$<iterations>$<saltHex>$<hashHex>。
func HashPassword(password string) (string, error) {
	salt := make([]byte, saltBytes)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("%w: %v", ErrRandFailure, err)
	}
	key := pbkdf2Key([]byte(password), salt, pbkdf2Iterations, keyBytes)
	return strings.Join([]string{
		passwordFormat,
		strconv.Itoa(pbkdf2Iterations),
		hex.EncodeToString(salt),
		hex.EncodeToString(key),
	}, "$"), nil
}

// VerifyPassword 校验密码与存储哈希；格式非法时返回 false 而不 panic。
func VerifyPassword(password, stored string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 4 || parts[0] != passwordFormat {
		return false
	}
	iterations, err := strconv.Atoi(parts[1])
	if err != nil || iterations <= 0 || iterations > 1_000_000 {
		return false
	}
	salt, err := hex.DecodeString(parts[2])
	if err != nil {
		return false
	}
	want, err := hex.DecodeString(parts[3])
	if err != nil || len(want) == 0 {
		return false
	}
	got := pbkdf2Key([]byte(password), salt, iterations, len(want))
	return hmac.Equal(got, want)
}

// pbkdf2Key 实现 PBKDF2（RFC 8018）with HMAC-SHA256，避免引入 x/crypto 依赖。
func pbkdf2Key(password, salt []byte, iterations, keyLen int) []byte {
	prf := hmac.New(sha256.New, password)
	hLen := prf.Size()
	blocks := (keyLen + hLen - 1) / hLen
	key := make([]byte, 0, blocks*hLen)
	var index [4]byte
	for block := 1; block <= blocks; block++ {
		prf.Reset()
		_, _ = prf.Write(salt)
		binary.BigEndian.PutUint32(index[:], uint32(block))
		_, _ = prf.Write(index[:])
		u := prf.Sum(nil)
		t := make([]byte, len(u))
		copy(t, u)
		for i := 1; i < iterations; i++ {
			prf.Reset()
			_, _ = prf.Write(u)
			u = prf.Sum(nil)
			for j := range t {
				t[j] ^= u[j]
			}
		}
		key = append(key, t...)
	}
	return key[:keyLen]
}

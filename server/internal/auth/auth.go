// Package auth 提供密码哈希（argon2id）与 JWT 签发/校验、refresh token 生成。
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/argon2"
)

const (
	accessTTL    = 15 * time.Minute
	refreshTTL   = 30 * 24 * time.Hour
	argonTime    = 3
	argonMemory  = 64 * 1024
	argonThreads = 1
	argonKeyLen  = 32
)

// HashPassword 生成标准 argon2id 编码串。
func HashPassword(password string) string {
	salt := make([]byte, 16)
	_, _ = rand.Read(salt)
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key))
}

// VerifyPassword 常数时间校验密码。
func VerifyPassword(password, encoded string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false
	}
	var mem, t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &mem, &t, &p); err != nil {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, t, mem, p, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}

// Manager 签发与解析 HS256 access token。
type Manager struct{ secret []byte }

func NewManager(secret string) *Manager { return &Manager{secret: []byte(secret)} }

func (m *Manager) IssueAccess(userID int64) (string, error) {
	claims := jwt.MapClaims{
		"sub": strconv.FormatInt(userID, 10),
		"iat": time.Now().Unix(),
		"exp": time.Now().Add(accessTTL).Unix(),
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(m.secret)
}

func (m *Manager) ParseAccess(tokenStr string) (int64, error) {
	tok, err := jwt.Parse(tokenStr, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return m.secret, nil
	})
	if err != nil {
		return 0, err
	}
	mc, ok := tok.Claims.(jwt.MapClaims)
	if !ok || !tok.Valid {
		return 0, errors.New("invalid token")
	}
	sub, ok := mc["sub"].(string)
	if !ok {
		return 0, errors.New("missing sub")
	}
	return strconv.ParseInt(sub, 10, 64)
}

// NewRefreshToken 生成不透明 refresh token 与过期时间（使用方负责轮换存储）。
func NewRefreshToken() (string, time.Time) {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b), time.Now().Add(refreshTTL)
}

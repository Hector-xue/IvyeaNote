// 管理员引导：自托管模式下，账号由部署者在服务端环境变量中配置，
// 而不是通过公开注册接口创建。首次启动自动建号；密码为空时生成随机
// 初始密码并打印到日志（仅一次），之后重启不会覆盖已有密码。
package api

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"log"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ivyea/ivyea-note/server/internal/auth"
)

// EnsureAdmin 确保管理员账号存在。
//
//   - 账号已存在且未提供新密码 → 保留现状（适合日常重启）
//   - 账号已存在且提供了新密码 → 更新密码（部署者改 .env 后重启即可改密）
//   - 账号不存在 → 创建；password 为空时生成随机密码并打印到日志
func EnsureAdmin(ctx context.Context, pool *pgxpool.Pool, email, password string) error {
	if email == "" {
		email = "admin@example.com"
	}
	var id int64
	var hash string
	err := pool.QueryRow(ctx, `SELECT id, password_hash FROM users WHERE email=$1`, email).Scan(&id, &hash)
	if err == nil {
		if password != "" && !auth.VerifyPassword(password, hash) {
			newHash := auth.HashPassword(password)
			if _, err := pool.Exec(ctx, `UPDATE users SET password_hash=$1 WHERE id=$2`, newHash, id); err != nil {
				return err
			}
			log.Printf("管理员 %s 的密码已按 IVNOTE_ADMIN_PASSWORD 更新", email)
		}
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}

	if password == "" {
		b := make([]byte, 9)
		if _, err := rand.Read(b); err != nil {
			return err
		}
		password = base64.RawURLEncoding.EncodeToString(b)
		log.Printf("──────────────────────────────────────────────")
		log.Printf("首次启动：已创建管理员账号 %s", email)
		log.Printf("初始密码: %s", password)
		log.Printf("请立即登录使用，或在 .env 设置 IVNOTE_ADMIN_PASSWORD 固定密码")
		log.Printf("──────────────────────────────────────────────")
	}
	newHash := auth.HashPassword(password)
	if _, err := pool.Exec(ctx, `INSERT INTO users(email, password_hash) VALUES($1,$2)`, email, newHash); err != nil {
		return err
	}
	log.Printf("管理员账号就绪: %s", email)
	return nil
}

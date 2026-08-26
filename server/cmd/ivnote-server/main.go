// ivnote-server：Ivyea Note 同步服务入口。
// 配置全部来自环境变量：
//
//	IVNOTE_DB                 存储后端："sqlite"（默认）或 "postgres"
//	IVNOTE_SQLITE_PATH        SQLite 文件路径（默认 ./ivnote.db，IVNOTE_DB=sqlite 时生效）
//	IVNOTE_DATABASE_URL       PostgreSQL 连接串（IVNOTE_DB=postgres 时必填）
//	IVNOTE_SECRET             JWT 签名密钥；留空则自动生成并写入数据目录（重启沿用）
//	IVNOTE_LISTEN             默认 :8080
//	IVNOTE_ADMIN_EMAIL        管理员账号（默认 admin@example.com）
//	IVNOTE_ADMIN_PASSWORD     管理员密码；留空则首次启动生成随机密码打印到日志
//	IVNOTE_OPEN_REGISTRATION  是否开放公开注册（自托管默认关闭）
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/ivyea/ivyea-note/server/internal/api"
	"github.com/ivyea/ivyea-note/server/internal/auth"
	"github.com/ivyea/ivyea-note/server/internal/store"
)

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func getbool(key string, def bool) bool {
	switch strings.ToLower(os.Getenv(key)) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	}
	return def
}

// loadOrCreateSecret：SECRET 留空时自动生成并持久化到数据目录，重启沿用。
// 免去用户手写 openssl 的门槛（密钥变了会导致所有已发 token 失效）。
func loadOrCreateSecret(dataDir string) string {
	if s := os.Getenv("IVNOTE_SECRET"); s != "" {
		return s
	}
	file := filepath.Join(dataDir, "secret.key")
	if b, err := os.ReadFile(file); err == nil && len(strings.TrimSpace(string(b))) >= 32 {
		return strings.TrimSpace(string(b))
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		log.Fatalf("生成随机密钥失败: %v", err)
	}
	secret := hex.EncodeToString(b)
	if err := os.WriteFile(file, []byte(secret), 0o600); err != nil {
		log.Fatalf("写入 %s 失败: %v", file, err)
	}
	log.Printf("已自动生成 JWT 密钥并保存到 %s", file)
	return secret
}

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)

	dbKind := strings.ToLower(getenv("IVNOTE_DB", "sqlite"))
	listen := getenv("IVNOTE_LISTEN", ":8080")

	ctx := context.Background()

	// 数据目录：SQLite 文件与自动生成密钥的落点
	dataDir := getenv("IVNOTE_DATA_DIR", ".")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		log.Fatalf("创建数据目录 %s 失败: %v", dataDir, err)
	}
	secret := loadOrCreateSecret(dataDir)

	var st store.Store
	var err error
	switch dbKind {
	case "sqlite", "":
		sqlitePath := getenv("IVNOTE_SQLITE_PATH", filepath.Join(dataDir, "ivnote.db"))
		st, err = store.ConnectSQLite(ctx, sqlitePath)
		if err != nil {
			log.Fatalf("打开 SQLite 失败: %v", err)
		}
		log.Printf("存储后端: SQLite (%s)", sqlitePath)
	case "postgres":
		dbURL := os.Getenv("IVNOTE_DATABASE_URL")
		if dbURL == "" {
			log.Fatal("IVNOTE_DB=postgres 时必须设置 IVNOTE_DATABASE_URL")
		}
		st, err = store.ConnectPG(ctx, dbURL)
		if err != nil {
			log.Fatalf("连接 PostgreSQL 失败: %v", err)
		}
		log.Printf("存储后端: PostgreSQL")
	default:
		log.Fatalf("未知 IVNOTE_DB=%q（支持 sqlite / postgres）", dbKind)
	}
	defer st.Close()

	type migrator interface{ Migrate(ctx context.Context) error }
	if m, ok := st.(migrator); ok {
		if err := m.Migrate(ctx); err != nil {
			log.Fatalf("数据库迁移失败: %v", err)
		}
	}
	log.Printf("数据库就绪")

	adminEmail := getenv("IVNOTE_ADMIN_EMAIL", "admin@example.com")
	if err := api.EnsureAdmin(ctx, st, adminEmail, os.Getenv("IVNOTE_ADMIN_PASSWORD")); err != nil {
		log.Fatalf("初始化管理员账号失败: %v", err)
	}

	openReg := getbool("IVNOTE_OPEN_REGISTRATION", false)
	srv := api.New(st, auth.NewManager(secret), api.NewHub(), openReg)
	if openReg {
		log.Printf("公开注册已开启 (IVNOTE_OPEN_REGISTRATION=true)")
	}

	httpSrv := &http.Server{
		Addr:              listen,
		Handler:           srv.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		log.Printf("ivnote-server 监听 %s", listen)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("监听失败: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutdownCtx)
	log.Printf("已优雅退出")
}

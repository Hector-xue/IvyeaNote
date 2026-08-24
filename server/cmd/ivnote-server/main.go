// ivnote-server：Ivyea Note 同步服务入口。
// 配置全部来自环境变量：
//
//	IVNOTE_DATABASE_URL       默认 postgres://ivnote:ivnote@127.0.0.1:5432/ivnote?sslmode=disable
//	IVNOTE_SECRET             JWT 签名密钥（必填）
//	IVNOTE_LISTEN             默认 :8080
//	IVNOTE_ADMIN_EMAIL        管理员账号（默认 admin@example.com）
//	IVNOTE_ADMIN_PASSWORD     管理员密码；留空则首次启动生成随机密码打印到日志
//	IVNOTE_OPEN_REGISTRATION  是否开放公开注册（自托管默认关闭）
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
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

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)

	secret := os.Getenv("IVNOTE_SECRET")
	if secret == "" {
		log.Fatal("环境变量 IVNOTE_SECRET 未设置（用于 JWT 签名，请给足够长的随机串）")
	}
	dbURL := getenv("IVNOTE_DATABASE_URL", "postgres://ivnote:ivnote@127.0.0.1:5432/ivnote?sslmode=disable")
	listen := getenv("IVNOTE_LISTEN", ":8080")

	ctx := context.Background()
	pool, err := store.Connect(ctx, dbURL)
	if err != nil {
		log.Fatalf("连接数据库失败: %v", err)
	}
	defer pool.Close()

	if err := store.Migrate(ctx, pool); err != nil {
		log.Fatalf("数据库迁移失败: %v", err)
	}
	log.Printf("数据库就绪")

	adminEmail := getenv("IVNOTE_ADMIN_EMAIL", "admin@example.com")
	if err := api.EnsureAdmin(ctx, pool, adminEmail, os.Getenv("IVNOTE_ADMIN_PASSWORD")); err != nil {
		log.Fatalf("初始化管理员账号失败: %v", err)
	}

	openReg := getbool("IVNOTE_OPEN_REGISTRATION", false)
	srv := api.New(pool, auth.NewManager(secret), api.NewHub(), openReg)
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
	log.Println("ivnote-server 已优雅退出")
}

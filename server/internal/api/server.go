// Package api：HTTP 层。H1（v0.6.0）起数据访问走 store.Store 接口，
// PostgreSQL 与 SQLite 双后端共用全部业务逻辑。
package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/ivyea/ivyea-note/server/internal/auth"
	"github.com/ivyea/ivyea-note/server/internal/store"
	ivsync "github.com/ivyea/ivyea-note/server/internal/sync"
)

const maxBlobSize = 50 << 20 // 50MB

type Server struct {
	st               store.Store
	jwt              *auth.Manager
	hub              *Hub
	log              *log.Logger
	openRegistration bool   // 是否开放公开注册（自托管默认关闭）
	adminEmail       string // 管理员账号（H8 管理接口鉴权用）
}

func New(st store.Store, jwtMgr *auth.Manager, hub *Hub, openRegistration bool, adminEmail string) *Server {
	return &Server{st: st, jwt: jwtMgr, hub: hub, log: log.Default(), openRegistration: openRegistration, adminEmail: adminEmail}
}

// Routes 注册全部路由（Go 1.22+ 方法模式）。
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		// 客户端「测试连接」读这个头来显示服务端版本；此前只有状态页带，
		// 于是探测成功时那句话永远是「✓ 已连接到 Ivyea Server」，没有版本号
		w.Header().Set("X-Ivyea-Version", serverVersion)
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /{$}", s.handleStatusPage)
	mux.HandleFunc("GET /admin", s.handleAdminPage)
	mux.HandleFunc("GET /app", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/app/", http.StatusMovedPermanently)
	})
	mux.Handle("/app/", http.HandlerFunc(s.handleWebUI))
	mux.HandleFunc("POST /api/v1/auth/register", s.handleRegister)
	mux.HandleFunc("POST /api/v1/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/v1/auth/refresh", s.handleRefresh)
	mux.Handle("GET /api/v1/vaults", s.authed(s.handleVaultList))
	mux.Handle("POST /api/v1/vaults", s.authed(s.handleVaultCreate))
	mux.Handle("POST /api/v1/devices", s.authed(s.handleDeviceRegister))
	mux.Handle("POST /api/v1/sync/push", s.authed(s.handlePush))
	mux.Handle("GET /api/v1/sync/changes", s.authed(s.handlePull))
	mux.Handle("PUT /api/v1/blobs/{hash}", s.authed(s.handleBlobPut))
	mux.Handle("GET /api/v1/blobs/{hash}", s.authed(s.handleBlobGet))
	mux.Handle("GET /api/v1/admin/users", s.requireAdmin(s.handleAdminUsers))
	mux.Handle("DELETE /api/v1/admin/users/{id}", s.requireAdmin(s.handleAdminDeleteUser))
	mux.Handle("POST /api/v1/pairing/create", s.authed(s.handlePairCreate))
	mux.HandleFunc("POST /api/v1/pairing/claim", s.handlePairClaim)
	// P3 Agent 融合：MCP endpoint（长期令牌鉴权，见 mcp.go）
	mux.HandleFunc("POST /mcp", s.handleMCP)
	mux.Handle("POST /api/v1/mcp/tokens", s.authed(s.handleMCPTokenCreate))
	mux.Handle("GET /api/v1/mcp/tokens", s.authed(s.handleMCPTokenList))
	mux.Handle("DELETE /api/v1/mcp/tokens/{id}", s.authed(s.handleMCPTokenDelete))
	mux.Handle("GET /ws", s.authedWS(s.hub.HandleWS))
	return withCORS(mux)
}

/*
withCORS 让**桌面端与安卓端**能连上这台服务器。

# 为什么以前没有也"没问题"

桌面端 / 安卓端的 WebView 源是 `http://tauri.localhost`（Linux 上是 `tauri://localhost`），
它去请求 `https://note.example.com/api/v1/...` 是**跨域**请求。服务端一个
`Access-Control-Allow-Origin` 都不给，浏览器就把响应整个拦掉，客户端拿到的是
`TypeError: Failed to fetch`——而客户端把这一类错误报成「域名解析失败或服务未启动」，
于是现象看起来像"服务器没起来"，实际上服务器 200 得好好的。

这条路**从来没通过**，而它一直没被发现，是因为历次端到端验证都跑在网页版
（`/app/` 由这台服务器自己托管）上——**同源，恰好绕开了 CORS**。
教训：验证方式必须覆盖真实客户端的来源，否则"验证通过"只证明了被验证的那条路。

# 为什么可以反射任意 Origin

这套 API 是 **Bearer 令牌**鉴权，不用 Cookie，因此不存在"浏览器自动带上凭据"
这一类 CSRF 风险：恶意页面拿不到别的源里存着的令牌，没有令牌这些接口一律 401。
所以这里反射请求方的 Origin 并**不**声明 `Allow-Credentials`——
这正是令牌鉴权 API 的标准姿势。静态页面（状态页 / 网页版）同源访问，加不加都无所谓。
*/
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			// 响应随 Origin 变化，必须告诉缓存别串台
			h.Add("Vary", "Origin")
			h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			/*
			 * ⚠️ **回显浏览器请求的头，而不是写死一张清单。**
			 *
			 * v0.11.5 第一版写死了 "Authorization, Content-Type"，结果
			 * **登录成功、同步全挂**：同步的每一条请求都带 `X-Device-Id`
			 * （见客户端 lib/api.ts），浏览器拿 Allow-Headers 逐条比对，
			 * 缺一个就整个请求发不出去。而登录不带那个头，所以看起来"能连上"。
			 * 写死清单等于把"客户端将来会不会加头"押在我记性上——回显才是对的。
			 */
			if req := r.Header.Get("Access-Control-Request-Headers"); req != "" {
				h.Set("Access-Control-Allow-Headers", req)
				h.Add("Vary", "Access-Control-Request-Headers")
			} else {
				h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Device-Id")
			}
			// 跨域下 JS 默认只读得到几个基本响应头；版本号要显式暴露，
			// 否则「连接测试」永远显示不出服务端版本
			h.Set("Access-Control-Expose-Headers", "X-Ivyea-Version")
			h.Set("Access-Control-Max-Age", "86400")
		}
		// 预检。此前没有任何 OPTIONS 路由，net/http 的 mux 直接回 405，
		// 于是带自定义头（Authorization / Content-Type）的请求连发都发不出去。
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ---------- 通用工具 ----------

type ctxKey int

const userIDKey ctxKey = 0

func userIDFrom(r *http.Request) int64 {
	id, _ := r.Context().Value(userIDKey).(int64)
	return id
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, errCode, msg string) {
	writeJSON(w, code, map[string]string{"code": errCode, "message": msg})
}

func decodeBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<20)).Decode(dst); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_json", "请求体不是合法 JSON")
		return false
	}
	return true
}

// ---------- 中间件 ----------

func (s *Server) authed(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uid, ok := s.parseBearer(w, r.Header.Get("Authorization"))
		if !ok {
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), userIDKey, uid)))
	})
}

func (s *Server) authedWS(next func(http.ResponseWriter, *http.Request, int64, string)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := r.URL.Query().Get("token")
		if token == "" {
			h := r.Header.Get("Authorization")
			if strings.HasPrefix(h, "Bearer ") {
				token = strings.TrimPrefix(h, "Bearer ")
			}
		}
		uid, ok := s.parseBearer(w, "Bearer "+token)
		if !ok {
			return
		}
		next(w, r, uid, r.URL.Query().Get("device"))
	})
}

func (s *Server) parseBearer(w http.ResponseWriter, header string) (int64, bool) {
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		writeErr(w, http.StatusUnauthorized, "unauthorized", "缺少 Bearer token")
		return 0, false
	}
	uid, err := s.jwt.ParseAccess(strings.TrimPrefix(header, prefix))
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "token_invalid", "token 无效或已过期")
		return 0, false
	}
	return uid, true
}

// ---------- 认证 ----------

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	// 自托管默认关闭公开注册：账号由部署者在服务端 .env 配置（IVNOTE_ADMIN_EMAIL/PASSWORD）。
	// 如需多用户，可在 .env 设置 IVNOTE_OPEN_REGISTRATION=true。
	if !s.openRegistration {
		writeErr(w, http.StatusForbidden, "registration_disabled",
			"此服务器未开放注册。请联系服务器管理员，或在部署端 .env 配置管理员账号。")
		return
	}
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	if !strings.Contains(req.Email, "@") || len(req.Password) < 8 {
		writeErr(w, http.StatusBadRequest, "bad_request", "email 不合法或密码少于 8 位")
		return
	}
	hash := auth.HashPassword(req.Password)
	id, err := s.st.CreateUser(r.Context(), req.Email, hash)
	switch {
	case errors.Is(err, store.ErrEmailExists):
		writeErr(w, http.StatusConflict, "email_exists", "该邮箱已注册")
		return
	case err != nil:
		writeErr(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"user_id": id})
}

func (s *Server) issueSession(w http.ResponseWriter, userID int64) {
	access, err := s.jwt.IssueAccess(userID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "token_error", err.Error())
		return
	}
	refresh, expires := auth.NewRefreshToken()
	if err := s.st.CreateRefreshToken(context.Background(), refresh, userID, expires); err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"access_token":  access,
		"refresh_token": refresh,
		"user_id":       userID,
	})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	u, err := s.st.GetUserByEmail(r.Context(), req.Email)
	if errors.Is(err, store.ErrNoRows) || (err == nil && !auth.VerifyPassword(req.Password, u.PasswordHash)) {
		writeErr(w, http.StatusUnauthorized, "bad_credentials", "邮箱或密码错误")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	s.issueSession(w, u.ID)
}

func (s *Server) handleRefresh(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RefreshToken string `json:"refresh_token"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	userID, err := s.st.GetRefreshTokenUser(r.Context(), req.RefreshToken)
	if errors.Is(err, store.ErrNoRows) {
		writeErr(w, http.StatusUnauthorized, "refresh_invalid", "refresh token 无效或已过期")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	// 轮换：旧的立即作废
	if err := s.st.DeleteRefreshToken(r.Context(), req.RefreshToken); err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	s.issueSession(w, userID)
}

func (s *Server) handleDeviceRegister(w http.ResponseWriter, r *http.Request) {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	deviceID := hex.EncodeToString(b)
	if err := s.st.CreateDevice(r.Context(), deviceID, userIDFrom(r)); err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"device_id": deviceID})
}

// ---------- Vault ----------

func (s *Server) ownVault(r *http.Request, vaultID int64) bool {
	ok, err := s.st.VaultOwnedBy(r.Context(), vaultID, userIDFrom(r))
	return err == nil && ok
}

func (s *Server) handleVaultList(w http.ResponseWriter, r *http.Request) {
	vaults, err := s.st.ListVaults(r.Context(), userIDFrom(r))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	type vault struct {
		ID        int64     `json:"id"`
		Name      string    `json:"name"`
		CreatedAt time.Time `json:"created_at"`
	}
	list := make([]vault, 0, len(vaults))
	for _, v := range vaults {
		list = append(list, vault{ID: v.ID, Name: v.Name, CreatedAt: v.CreatedAt})
	}
	writeJSON(w, http.StatusOK, map[string]any{"vaults": list})
}

func (s *Server) handleVaultCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if !decodeBody(w, r, &req) || strings.TrimSpace(req.Name) == "" {
		writeErr(w, http.StatusBadRequest, "bad_request", "name 不能为空")
		return
	}
	id, err := s.st.CreateVault(r.Context(), userIDFrom(r), req.Name)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id, "name": req.Name})
}

// ---------- 同步 ----------

func (s *Server) handlePush(w http.ResponseWriter, r *http.Request) {
	var req struct {
		VaultID int64               `json:"vault_id"`
		Changes []ivsync.PushChange `json:"changes"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	if !s.ownVault(r, req.VaultID) {
		writeErr(w, http.StatusForbidden, "forbidden", "vault 不存在或不属于你")
		return
	}
	deviceID := r.Header.Get("X-Device-Id")
	if deviceID == "" {
		deviceID = "unknown"
	}
	ctx := r.Context()
	tx, err := s.st.BeginTx(ctx)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	defer func() { _ = tx.Rollback() }()

	results := make([]ivsync.PushResult, 0, len(req.Changes))
	failed := false
	for _, ch := range req.Changes {
		res, err := ivsync.ApplyPush(ctx, tx, req.VaultID, userIDFrom(r), deviceID, ch)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "db_error", err.Error())
			failed = true
			break
		}
		results = append(results, res)
	}
	if failed {
		return
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	s.hub.BroadcastDirty(userIDFrom(r), req.VaultID, deviceID)
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

func (s *Server) handlePull(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	vaultID, err := strconv.ParseInt(q.Get("vault_id"), 10, 64)
	if err != nil || !s.ownVault(r, vaultID) {
		writeErr(w, http.StatusForbidden, "forbidden", "vault_id 无效或不属于你")
		return
	}
	cursor, _ := strconv.ParseInt(q.Get("cursor"), 10, 64)
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 1000 {
		limit = 500
	}
	changes, next, err := ivsync.Pull(r.Context(), s.st, vaultID, cursor, limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"changes": changes, "next_cursor": next})
}

// ---------- Blob ----------

func (s *Server) handleBlobPut(w http.ResponseWriter, r *http.Request) {
	wantHash := r.PathValue("hash")
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBlobSize+1))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "read_error", "读取请求体失败")
		return
	}
	if len(body) > maxBlobSize {
		writeErr(w, http.StatusRequestEntityTooLarge, "too_large", "单文件上限 50MB")
		return
	}
	if err := s.st.PutBlob(r.Context(), wantHash, userIDFrom(r), body); err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	// 内容寻址：服务端校验哈希（原逻辑在写库前比对，此处保持同等安全性）
	writeJSON(w, http.StatusCreated, map[string]any{"hash": wantHash, "size": len(body)})
}

func (s *Server) handleBlobGet(w http.ResponseWriter, r *http.Request) {
	hash := r.PathValue("hash")
	content, err := s.st.GetBlob(r.Context(), hash, userIDFrom(r))
	if errors.Is(err, store.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "blob 不存在")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.Itoa(len(content)))
	_, _ = w.Write(content)
}

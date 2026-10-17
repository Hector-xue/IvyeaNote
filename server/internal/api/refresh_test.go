package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ivyea/ivyea-note/server/internal/auth"
	"github.com/ivyea/ivyea-note/server/internal/store"
)

/*
v0.11.40 回归：轮换后旧 refresh token 在宽限期内还能用。

2026-10-17 新手机：09:22:43 轮换出新 token，安卓 WebView 的 localStorage 还没刷盘
应用就被回收了；09:24:54 重开拿旧 token 来刷——原来是当场 DELETE，于是 refresh_invalid，
只能重新登录。
*/

func refreshServer(t *testing.T) (*Server, *store.SQLiteStore) {
	t.Helper()
	ctx := context.Background()
	st, err := store.ConnectSQLite(ctx, filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	return New(st, auth.NewManager("test-secret"), NewHub(), false, ""), st
}

func doRefresh(s *Server, token string) (int, string) {
	r := httptest.NewRequest(http.MethodPost, "/api/v1/auth/refresh",
		strings.NewReader(`{"refresh_token":"`+token+`"}`))
	w := httptest.NewRecorder()
	s.handleRefresh(w, r)
	var body struct {
		RefreshToken string `json:"refresh_token"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	return w.Code, body.RefreshToken
}

func TestRefresh_旧token宽限期内仍可用(t *testing.T) {
	s, st := refreshServer(t)
	ctx := context.Background()
	uid, err := st.CreateUser(ctx, "a@example.com", "x")
	if err != nil {
		t.Fatal(err)
	}
	r0, exp := auth.NewRefreshToken()
	if err := st.CreateRefreshToken(ctx, r0, uid, exp); err != nil {
		t.Fatal(err)
	}

	code, r1 := doRefresh(s, r0)
	if code != http.StatusOK || r1 == "" || r1 == r0 {
		t.Fatalf("第一次轮换应成功并发新 token：%d %q", code, r1)
	}
	// 新 token 没存下来，应用重开拿的还是 r0
	if code, r2 := doRefresh(s, r0); code != http.StatusOK || r2 == "" {
		t.Fatalf("宽限期内旧 token 应仍能刷新，得到 %d", code)
	}
	if code, _ := doRefresh(s, r1); code != http.StatusOK {
		t.Fatalf("新 token 当然也能用，得到 %d", code)
	}
}

func TestRefresh_宽限期过后旧token失效(t *testing.T) {
	s, st := refreshServer(t)
	ctx := context.Background()
	uid, _ := st.CreateUser(ctx, "b@example.com", "x")
	r0, exp := auth.NewRefreshToken()
	_ = st.CreateRefreshToken(ctx, r0, uid, exp)

	if code, _ := doRefresh(s, r0); code != http.StatusOK {
		t.Fatalf("轮换应成功，得到 %d", code)
	}
	// 模拟宽限期已过：把截止时间挪到过去（RetireRefreshToken 只会截短不会延长）
	if err := st.RetireRefreshToken(ctx, r0, time.Now().Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	if code, _ := doRefresh(s, r0); code != http.StatusUnauthorized {
		t.Fatalf("宽限期过后旧 token 应是 401，得到 %d", code)
	}
}

func TestRefresh_截短不会延长已经更短的有效期(t *testing.T) {
	_, st := refreshServer(t)
	ctx := context.Background()
	uid, _ := st.CreateUser(ctx, "c@example.com", "x")
	tok, _ := auth.NewRefreshToken()
	_ = st.CreateRefreshToken(ctx, tok, uid, time.Now().Add(-time.Minute)) // 已过期
	if err := st.RetireRefreshToken(ctx, tok, time.Now().Add(refreshGrace)); err != nil {
		t.Fatal(err)
	}
	if _, err := st.GetRefreshTokenUser(ctx, tok); err == nil {
		t.Fatal("已过期的 token 不能被轮换「续命」")
	}
}

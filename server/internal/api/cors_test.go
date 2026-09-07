package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

/*
CORS 的回归用例。

这条路**从来没通过过**：桌面端与安卓端的 WebView 源是 `http://tauri.localhost`，
对这台服务器而言是跨域；服务端一个 CORS 头都不给，浏览器把响应整个拦掉，
客户端只看到 `TypeError: Failed to fetch`。而它一直没被发现，是因为历次端到端
验证都跑在网页版（`/app/` 同源）上——恰好绕开了 CORS。

所以这里锁的不是"某个 header 拼对了"，是**跨域客户端能不能用这台服务器**。
*/

func corsHandler() http.Handler {
	return withCORS(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
}

func TestCORSReflectsOrigin(t *testing.T) {
	for _, origin := range []string{
		"http://tauri.localhost", // Windows / 安卓 WebView
		"tauri://localhost",      // Linux WebView
		"https://note.example.com",
	} {
		req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
		req.Header.Set("Origin", origin)
		rec := httptest.NewRecorder()
		corsHandler().ServeHTTP(rec, req)

		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != origin {
			t.Fatalf("Origin %q：期望回显同一个源，实际 %q", origin, got)
		}
		if rec.Header().Get("Vary") != "Origin" {
			t.Fatalf("Origin %q：缺 Vary: Origin，缓存会串台", origin)
		}
		if rec.Code != http.StatusOK {
			t.Fatalf("Origin %q：状态码 %d", origin, rec.Code)
		}
	}
}

func TestCORSPreflightNotRejected(t *testing.T) {
	// 带 Authorization / Content-Type 的请求会先发 OPTIONS 预检。
	// 此前没有任何 OPTIONS 路由，net/http 的 mux 直接回 405 —— 请求根本发不出去。
	req := httptest.NewRequest(http.MethodOptions, "/api/v1/auth/login", nil)
	req.Header.Set("Origin", "http://tauri.localhost")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "content-type")
	rec := httptest.NewRecorder()
	corsHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("预检期望 204，实际 %d（405 就是「连不上」的那个根因）", rec.Code)
	}
	if h := rec.Header().Get("Access-Control-Allow-Headers"); h == "" {
		t.Fatal("预检没有回 Access-Control-Allow-Headers，带 Authorization 的请求会被拦")
	}
	if m := rec.Header().Get("Access-Control-Allow-Methods"); m == "" {
		t.Fatal("预检没有回 Access-Control-Allow-Methods")
	}
}

func TestCORSNoOriginNoHeaders(t *testing.T) {
	// 同源请求与 curl 不带 Origin，不该平白多出一组 CORS 头
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	corsHandler().ServeHTTP(rec, req)
	if rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("没有 Origin 时不该输出 Access-Control-Allow-Origin")
	}
}

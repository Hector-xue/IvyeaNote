package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// 每个用例都从干净的限速状态开始：pairing 是包级单例，不清会互相串味
func resetPairing() {
	pairing.mu.Lock()
	defer pairing.mu.Unlock()
	pairing.codes = map[string]*pairEntry{}
	pairing.fails = map[string]int{}
	pairing.failUntil = map[string]time.Time{}
}

func claimReq(code, remoteAddr, realIP string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/v1/pairing/claim?code="+code, nil)
	r.RemoteAddr = remoteAddr
	if realIP != "" {
		r.Header.Set("X-Real-IP", realIP)
	}
	return r
}

/*
 * v0.10.3 回归：原来是 `failsExceeded(ip) { return true }`——第一次输错就锁 5 分钟。
 * 配对码是手输的 6 位数字，手滑是常态不是攻击。
 */
func TestPairClaim_一次输错不该直接锁定(t *testing.T) {
	resetPairing()
	s := &Server{}

	w := httptest.NewRecorder()
	s.handlePairClaim(w, claimReq("000000", "10.0.0.9:1234", ""))

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("第一次输错应是 401 配对码无效，得到 %d：%s", w.Code, w.Body.String())
	}
	if got := w.Body.String(); got == "" || !contains(got, "还可尝试") {
		t.Fatalf("应告诉用户还剩几次，得到：%s", got)
	}
}

func TestPairClaim_连续失败到阈值才锁定(t *testing.T) {
	resetPairing()
	s := &Server{}
	const ip = "10.0.0.9:1234"

	for i := 1; i < pairMaxFails; i++ {
		w := httptest.NewRecorder()
		s.handlePairClaim(w, claimReq("000000", ip, ""))
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("第 %d 次失败应仍是 401，得到 %d", i, w.Code)
		}
	}

	w := httptest.NewRecorder()
	s.handlePairClaim(w, claimReq("000000", ip, ""))
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("第 %d 次失败应锁定（429），得到 %d", pairMaxFails, w.Code)
	}
}

/*
 * v0.10.3 回归：原来取的是 r.RemoteAddr——站在 nginx 后面它恒等于 127.0.0.1，
 * 于是限速桶只有一个：任何人输错，所有人一起被锁。
 */
func TestPairClaim_反代后按真实IP分桶而不是全局锁死(t *testing.T) {
	resetPairing()
	s := &Server{}

	// 甲把自己刷到锁定（全部经由本机 nginx 转发）
	for i := 0; i < pairMaxFails; i++ {
		w := httptest.NewRecorder()
		s.handlePairClaim(w, claimReq("000000", "127.0.0.1:5555", "203.0.113.7"))
		_ = w
	}
	w := httptest.NewRecorder()
	s.handlePairClaim(w, claimReq("000000", "127.0.0.1:5555", "203.0.113.7"))
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("甲应已被锁定，得到 %d", w.Code)
	}

	// 乙走同一个反代，不该被甲连累
	w2 := httptest.NewRecorder()
	s.handlePairClaim(w2, claimReq("000000", "127.0.0.1:5556", "203.0.113.8"))
	if w2.Code == http.StatusTooManyRequests {
		t.Fatalf("乙被甲的失败连坐了——限速桶又变回全局的了")
	}
}

/* 公网直连的客户端不能靠伪造 X-Real-IP 换桶绕过限速 */
func TestPairClaim_不信任非反代来源的转发头(t *testing.T) {
	resetPairing()
	s := &Server{}

	for i := 0; i < pairMaxFails; i++ {
		w := httptest.NewRecorder()
		// RemoteAddr 是公网地址 → 转发头一律不采信
		s.handlePairClaim(w, claimReq("000000", "203.0.113.7:4444", "1.2.3.4"))
		_ = w
	}
	w := httptest.NewRecorder()
	s.handlePairClaim(w, claimReq("000000", "203.0.113.7:4444", "9.9.9.9"))
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("换个伪造的 X-Real-IP 就绕过了限速，得到 %d", w.Code)
	}
}

func TestClientIP(t *testing.T) {
	cases := []struct {
		name       string
		remoteAddr string
		realIP     string
		xff        string
		want       string
	}{
		{"直连公网", "203.0.113.7:4444", "", "", "203.0.113.7"},
		{"反代 + X-Real-IP", "127.0.0.1:5555", "203.0.113.7", "", "203.0.113.7"},
		{"反代 + XFF 取最左", "127.0.0.1:5555", "", "203.0.113.7, 70.41.3.18", "203.0.113.7"},
		{"公网直连时忽略伪造头", "203.0.113.7:4444", "1.2.3.4", "5.6.7.8", "203.0.113.7"},
		{"内网直连也算可信反代", "10.0.0.2:5555", "203.0.113.7", "", "203.0.113.7"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/x", nil)
			r.RemoteAddr = c.remoteAddr
			if c.realIP != "" {
				r.Header.Set("X-Real-IP", c.realIP)
			}
			if c.xff != "" {
				r.Header.Set("X-Forwarded-For", c.xff)
			}
			if got := clientIP(r); got != c.want {
				t.Fatalf("clientIP = %q，期望 %q", got, c.want)
			}
		})
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

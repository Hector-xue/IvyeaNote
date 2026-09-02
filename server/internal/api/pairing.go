// v0.6.1 H6：扫码配对。
// 桌面端（已登录）调 POST /api/v1/pairing/create 拿一次性配对码（6 位，60 秒过期）；
// 手机端扫码/输码后调 POST /api/v1/pairing/claim，凭码+登录态换取……不——
// 手机端尚未登录，正确流程是：桌面端把「服务器地址+管理员生成的邀请」编码进二维码。
// 自托管单管理员场景简化：claim 时需要管理员邮箱密码登录成功才下发该账号的会话，
// 即二维码 = 一次性「免输服务器地址」凭证，密码仍由用户输一次（或桌面端把密码加密放进码里——
// 为安全起见本实现不放密码，只放地址+配对码；claim 成功后按码所属账号直接签发会话，
// 前提是 claim 请求携带配对码即可（码本身就是短时凭证，60 秒+一次性+限速）。
package api

import (
	"crypto/rand"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

type pairEntry struct {
	userID    int64
	expiresAt time.Time
	used      bool
}

type pairStore struct {
	mu        sync.Mutex
	codes     map[string]*pairEntry
	fails     map[string]int       // 客户端 IP -> 连续失败次数
	failUntil map[string]time.Time // 客户端 IP -> 限速到该时间点
}

var pairing = &pairStore{
	codes:     map[string]*pairEntry{},
	fails:     map[string]int{},
	failUntil: map[string]time.Time{},
}

const (
	pairTTL      = 60 * time.Second
	pairMaxFails = 5
	pairLockout  = 5 * time.Minute
)

// genPairCode 生成 6 位数字码。
func genPairCode() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	const digits = "0123456789"
	code := make([]byte, 6)
	for i := range code {
		code[i] = digits[b[i]%10]
	}
	return string(code), nil
}

// handlePairCreate（需登录）：生成一次性配对码，绑定当前账号。
func (s *Server) handlePairCreate(w http.ResponseWriter, r *http.Request) {
	code, err := genPairCode()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "pair_error", err.Error())
		return
	}
	pairing.mu.Lock()
	defer pairing.mu.Unlock()
	// 清理过期项
	now := time.Now()
	for k, e := range pairing.codes {
		if e.expiresAt.Before(now) || e.used {
			delete(pairing.codes, k)
		}
	}
	pairing.codes[code] = &pairEntry{userID: userIDFrom(r), expiresAt: now.Add(pairTTL)}
	writeJSON(w, http.StatusCreated, map[string]any{"code": code, "expires_in": int(pairTTL.Seconds())})
}

// handlePairClaim（无需登录）：凭配对码换会话。一次性 + 60 秒过期 + 按 IP 限速。
func (s *Server) handlePairClaim(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	pairing.mu.Lock()
	if until, bad := pairing.failUntil[ip]; bad && time.Now().Before(until) {
		pairing.mu.Unlock()
		writeErr(w, http.StatusTooManyRequests, "too_many", "尝试次数过多，请 5 分钟后再试")
		return
	}
	e, ok := pairing.codes[r.URL.Query().Get("code")]
	if !ok || e.used || e.expiresAt.Before(time.Now()) {
		locked := noteFailure(ip)
		if locked {
			pairing.failUntil[ip] = time.Now().Add(pairLockout)
		}
		left := pairMaxFails - pairing.fails[ip]
		pairing.mu.Unlock()
		if locked {
			writeErr(w, http.StatusTooManyRequests, "too_many", "尝试次数过多，请 5 分钟后再试")
			return
		}
		// 说清楚还剩几次：不然用户不知道自己离被锁还有多远
		writeErr(w, http.StatusUnauthorized, "pair_invalid",
			fmt.Sprintf("配对码无效或已过期（还可尝试 %d 次）", left))
		return
	}
	e.used = true // 一次性：无论后续登录是否成功，码立即作废
	delete(pairing.fails, ip) // 成功即清零，别让之前的手滑攒到下一次
	pairing.mu.Unlock()
	s.issueSession(w, e.userID)
}

/*
 * 记一次失败，返回是否该锁定。**调用方必须已持有 pairing.mu**。
 *
 * v0.10.3 修：原实现是 `func failsExceeded(ip string) bool { return true }`——
 * 恒为真，声明好的 pairMaxFails=5 一次都没被用上，于是**第一次输错就锁 5 分钟**。
 * 配对码是手输的 6 位数字，手滑是常态而不是攻击，一次就锁等于这个功能不可用。
 */
func noteFailure(ip string) bool {
	pairing.fails[ip]++
	if pairing.fails[ip] >= pairMaxFails {
		delete(pairing.fails, ip) // 锁定期本身就是惩罚，计数归零重新来过
		return true
	}
	return false
}

/*
 * 取真实客户端 IP。
 *
 * v0.10.3 修：原来直接用 r.RemoteAddr——**站在 nginx 后面它永远是 127.0.0.1**，
 * 于是限速桶只有一个，任何人输错一次就把**所有人**一起锁掉 5 分钟。
 *
 * 只有当直连方是回环/内网（也就是我们自己的反代）时才采信转发头；
 * 否则公网客户端可以随便伪造 X-Forwarded-For 来绕过限速。
 */
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if !isTrustedProxy(host) {
		return host
	}
	if v := strings.TrimSpace(r.Header.Get("X-Real-IP")); v != "" {
		return v
	}
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		// 最左边是最初的客户端；中间可能有伪造，但链路上第一跳是我们信任的反代
		if i := strings.IndexByte(v, ','); i >= 0 {
			v = v[:i]
		}
		if v = strings.TrimSpace(v); v != "" {
			return v
		}
	}
	return host
}

// isTrustedProxy：回环与私有网段视为自己的反代
func isTrustedProxy(host string) bool {
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()
}

// MCP 长期令牌的管理接口（P3）。
//
// 为什么不复用 access token：它 15 分钟就过期，而 MCP 客户端没有刷新逻辑。
// 让机器拿短票的结果是「今天配好能用、明天悄悄不能用」，比一开始就拒绝更难查。
//
// 三条纪律：
//   - **明文不落库**，只存 sha256；
//   - 明文**只在创建时回显一次**，丢了就重发一张，不提供「再看一遍」；
//   - 随时可撤销，列表里给前 8 位哈希便于辨认是哪张。
package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// hashToken 令牌明文 → 落库用的 sha256 十六进制。
func hashToken(plain string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(plain)))
	return hex.EncodeToString(sum[:])
}

// newMCPToken 生成一张令牌明文。前缀让人一眼看出这是什么东西，
// 也方便日后在日志/仓库扫描里用规则揪出被误提交的密钥。
func newMCPToken() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return "ivnote_mcp_" + hex.EncodeToString(buf), nil
}

func (s *Server) handleMCPTokenCreate(w http.ResponseWriter, r *http.Request) {
	uid := r.Context().Value(userIDKey).(int64)
	var body struct {
		Name string `json:"name"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body) // name 可省
	name := strings.TrimSpace(body.Name)
	if name == "" {
		name = "未命名"
	}
	plain, err := newMCPToken()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", "生成令牌失败")
		return
	}
	if err := s.st.CreateMCPToken(r.Context(), hashToken(plain), uid, name); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", "保存令牌失败")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"token": plain,
		"name":  name,
		"note":  "这串明文只显示这一次，请立刻保存。丢了就重新签发一张。",
	})
}

func (s *Server) handleMCPTokenList(w http.ResponseWriter, r *http.Request) {
	uid := r.Context().Value(userIDKey).(int64)
	list, err := s.st.ListMCPTokens(r.Context(), uid)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", "读取失败")
		return
	}
	out := make([]map[string]any, 0, len(list))
	for _, t := range list {
		item := map[string]any{
			"id":         t.ID,
			"name":       t.Name,
			"prefix":     t.Prefix,
			"created_at": t.CreatedAt.UTC().Format(time.RFC3339),
		}
		if t.LastUsedAt != nil {
			item["last_used_at"] = t.LastUsedAt.UTC().Format(time.RFC3339)
		}
		out = append(out, item)
	}
	writeJSON(w, http.StatusOK, map[string]any{"tokens": out})
}

func (s *Server) handleMCPTokenDelete(w http.ResponseWriter, r *http.Request) {
	uid := r.Context().Value(userIDKey).(int64)
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "id 不合法")
		return
	}
	if err := s.st.DeleteMCPToken(r.Context(), uid, id); err != nil {
		writeErr(w, http.StatusNotFound, "not_found", "没有这张令牌")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": id})
}

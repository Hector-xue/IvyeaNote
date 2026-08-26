// v0.7.0 H8：管理员 API——账号列表/删除/容量统计。
// 鉴权：仅管理员账号（IVNOTE_ADMIN_EMAIL 配置的账号）可访问。
package api

import (
	"errors"
	"net/http"
	"strings"

)

// isAdminAccount：当前登录用户是否管理员（按邮箱比对部署配置）。
func (s *Server) isAdminAccount(r *http.Request) bool {
	u, err := s.st.GetUserByEmail(r.Context(), s.adminEmail)
	return err == nil && u.ID == userIDFrom(r)
}

func (s *Server) requireAdmin(next http.HandlerFunc) http.Handler {
	return s.authed(func(w http.ResponseWriter, r *http.Request) {
		if !s.isAdminAccount(r) {
			writeErr(w, http.StatusForbidden, "forbidden", "仅管理员可操作")
			return
		}
		next(w, r)
	})
}

// handleAdminUsers：账号列表 + 每账号容量（blob 字节数）。
func (s *Server) handleAdminUsers(w http.ResponseWriter, r *http.Request) {
	type userInfo struct {
		ID        int64   `json:"id"`
		Email     string  `json:"email"`
		BytesUsed int64   `json:"bytes_used"`
		Vaults    int     `json:"vaults"`
	}
	admin, err := s.st.GetUserByEmail(r.Context(), s.adminEmail)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	users, err := s.st.ListUsers(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	out := make([]userInfo, 0, len(users))
	for _, u := range users {
		bytes, _ := s.st.UserBlobBytes(r.Context(), u.ID)
		vaults, _ := s.st.ListVaults(r.Context(), u.ID)
		role := ""
		if admin != nil && u.ID == admin.ID {
			role = "admin"
		}
		out = append(out, userInfo{ID: u.ID, Email: u.Email, BytesUsed: bytes, Vaults: len(vaults)})
		_ = role
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": out})
}

// handleAdminDeleteUser：删除账号及其全部数据（级联）。
func (s *Server) handleAdminDeleteUser(w http.ResponseWriter, r *http.Request) {
	uid, err := parseIDParam(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "无效的用户 id")
		return
	}
	admin, err := s.st.GetUserByEmail(r.Context(), s.adminEmail)
	if err == nil && admin.ID == uid {
		writeErr(w, http.StatusBadRequest, "cannot_delete_admin", "不能删除管理员账号")
		return
	}
	if err := s.st.DeleteUser(r.Context(), uid); err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func parseIDParam(r *http.Request) (int64, error) {
	idStr := strings.TrimPrefix(r.PathValue("id"), "")
	var id int64
	for _, c := range idStr {
		if c < '0' || c > '9' {
			return 0, errBadID
		}
		id = id*10 + int64(c-'0')
	}
	if id <= 0 {
		return 0, errBadID
	}
	return id, nil
}

var errBadID = errors.New("bad id")

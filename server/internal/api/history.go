// 文件历史（v0.11.24）。
//
// 用户原话：「如果不小心在其中一端误删了或者误修改了文件然后又全端同步了，别的端也被
// 同步删了，怎么办？现在只有在回收站里面找到，但是被误修改的可真就无法找回了」。
//
// 事实是**每一版都还在**：协议从第一天起就规定 changes 流只追加、blob 内容寻址不删
// （shared/protocol.md §5）。缺的不是数据，是把它拿回来的那条路。这里给两条只读接口：
//
//   - GET /sync/history?vault_id&path[&limit]  某路径的历史版本（新的在前）
//   - GET /sync/deleted?vault_id               云端当前已删除的路径（附删除前最后一版）
//
// **恢复不需要新接口**：客户端把旧版 blob 写回本地文件，下一轮 push 就是一次普通的
// upsert（base_version = 当前版本），全端跟着收敛——和用户手动改回去是同一条路，
// 服务端不必知道"这是一次恢复"。
package api

import (
	"net/http"
	"strconv"

	ivsync "github.com/ivyea/ivyea-note/server/internal/sync"
)

// 一次最多列多少版：历史面板要的是"最近改过什么"，不是全量审计
const maxHistoryLimit = 200

type historyVersion struct {
	Version   int64   `json:"version"`
	Op        string  `json:"op"`
	BlobHash  *string `json:"blob_hash,omitempty"`
	Size      int64   `json:"size"`
	DeviceID  string  `json:"device_id"`
	CreatedAt string  `json:"created_at"`
}

type deletedFile struct {
	Path      string  `json:"path"`
	Version   int64   `json:"version"`
	BlobHash  *string `json:"blob_hash,omitempty"`
	Size      int64   `json:"size"`
	DeletedAt string  `json:"deleted_at"`
}

func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	vaultID, err := strconv.ParseInt(q.Get("vault_id"), 10, 64)
	if err != nil || !s.ownVault(r, vaultID) {
		writeErr(w, http.StatusForbidden, "forbidden", "vault_id 无效或不属于你")
		return
	}
	path := q.Get("path")
	if err := ivsync.ValidatePath(path); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_path", "path 无效")
		return
	}
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > maxHistoryLimit {
		limit = 50
	}
	rows, err := s.st.History(r.Context(), vaultID, path, limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	out := make([]historyVersion, 0, len(rows))
	for _, v := range rows {
		out = append(out, historyVersion{
			Version: v.Version, Op: v.Op, BlobHash: v.BlobHash, Size: v.Size,
			DeviceID: v.DeviceID, CreatedAt: v.CreatedAt.UTC().Format(rfc3339ms),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"versions": out})
}

func (s *Server) handleDeleted(w http.ResponseWriter, r *http.Request) {
	vaultID, err := strconv.ParseInt(r.URL.Query().Get("vault_id"), 10, 64)
	if err != nil || !s.ownVault(r, vaultID) {
		writeErr(w, http.StatusForbidden, "forbidden", "vault_id 无效或不属于你")
		return
	}
	rows, err := s.st.DeletedFiles(r.Context(), vaultID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	out := make([]deletedFile, 0, len(rows))
	for _, f := range rows {
		// 从没上传过内容就被删（理论上不会有）的路径没法恢复，不列
		if f.BlobHash == nil {
			continue
		}
		out = append(out, deletedFile{
			Path: f.Path, Version: f.Version, BlobHash: f.BlobHash, Size: f.Size,
			DeletedAt: f.DeletedAt.UTC().Format(rfc3339ms),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"files": out})
}

const rfc3339ms = "2006-01-02T15:04:05.000Z07:00"

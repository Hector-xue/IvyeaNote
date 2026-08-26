// Package sync 实现同步核心：push 冲突判定/幂等去重、pull 增量游标。
// 协议契约见 shared/protocol.md。
// H1（v0.6.0）：数据访问改走 store.Store/store.Tx 接口，PostgreSQL 与 SQLite 双后端共用本逻辑。
package sync

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/ivyea/ivyea-note/server/internal/store"
)

var ErrInvalidPath = errors.New("invalid path")

type PushChange struct {
	ClientChangeID string  `json:"client_change_id"`
	Path           string  `json:"path"`
	Op             string  `json:"op"` // upsert | delete
	BlobHash       *string `json:"blob_hash,omitempty"`
	BaseVersion    int64   `json:"base_version"`
}

type PushResult struct {
	ClientChangeID string  `json:"client_change_id"`
	Status         string  `json:"status"` // accepted | conflict | rejected
	Version        int64   `json:"version,omitempty"`
	ServerVersion  int64   `json:"server_version,omitempty"`
	ServerBlobHash *string `json:"server_blob_hash,omitempty"`
	Reason         string  `json:"reason,omitempty"`
}

type Change struct {
	Seq       int64     `json:"seq"`
	Path      string    `json:"path"`
	Op        string    `json:"op"`
	BlobHash  *string   `json:"blob_hash,omitempty"`
	Version   int64     `json:"version"`
	DeviceID  string    `json:"device_id"`
	CreatedAt time.Time `json:"created_at"`
}

// ValidatePath 拒绝绝对路径、..、反斜杠、空段，防目录穿越。
func ValidatePath(p string) error {
	if p == "" || strings.HasPrefix(p, "/") || strings.Contains(p, "\\") || strings.ContainsRune(p, 0) {
		return ErrInvalidPath
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return ErrInvalidPath
		}
	}
	return nil
}

func reject(id, reason string) PushResult {
	return PushResult{ClientChangeID: id, Status: "rejected", Reason: reason}
}

// ApplyPush 在事务内应用单条变更：幂等检查 → 冲突检测 → 写 heads + 追加 changes。
// 注意：delete 遇到更新的服务端版本会返回 conflict（修改胜出，由客户端复活本地文件）。
func ApplyPush(ctx context.Context, tx store.Tx, vaultID, userID int64, deviceID string, ch PushChange) (PushResult, error) {
	if err := ValidatePath(ch.Path); err != nil {
		return reject(ch.ClientChangeID, "invalid_path"), nil
	}
	if ch.Op != "upsert" && ch.Op != "delete" {
		return reject(ch.ClientChangeID, "invalid_op"), nil
	}
	if ch.Op == "upsert" && (ch.BlobHash == nil || *ch.BlobHash == "") {
		return reject(ch.ClientChangeID, "missing_blob_hash"), nil
	}

	// 幂等：同 (device_id, client_change_id) 重复提交直接返回当前状态
	dup, err := tx.ChangeExists(ctx, deviceID, ch.ClientChangeID)
	if err != nil {
		return PushResult{}, err
	}
	if dup {
		ver, bh, err := tx.CurrentVersion(ctx, vaultID, ch.Path)
		if err != nil {
			return PushResult{}, err
		}
		return PushResult{ClientChangeID: ch.ClientChangeID, Status: "accepted", Version: ver, ServerBlobHash: bh}, nil
	}

	// 冲突检测：base_version 必须等于服务端当前版本
	curVer, curHash, err := tx.CurrentVersion(ctx, vaultID, ch.Path)
	if err != nil {
		return PushResult{}, err
	}
	if ch.BaseVersion != curVer {
		return PushResult{
			ClientChangeID: ch.ClientChangeID,
			Status:         "conflict",
			ServerVersion:  curVer,
			ServerBlobHash: curHash,
		}, nil
	}

	newVer := curVer + 1
	if ch.Op == "upsert" {
		known, err := tx.BlobExists(ctx, *ch.BlobHash, userID)
		if err != nil {
			return PushResult{}, err
		}
		if !known {
			return reject(ch.ClientChangeID, "unknown_blob"), nil
		}
	}
	if err := tx.UpsertHead(ctx, store.Head{
		VaultID:  vaultID,
		Path:     ch.Path,
		Version:  newVer,
		BlobHash: ch.BlobHash,
		Deleted:  ch.Op == "delete",
	}); err != nil {
		return PushResult{}, err
	}

	if err := tx.AppendChange(ctx, &store.Change{
		VaultID:  vaultID,
		DeviceID: deviceID,
		ClientID: ch.ClientChangeID,
		Path:     ch.Path,
		Op:       ch.Op,
		BlobHash: ch.BlobHash,
		Version:  newVer,
		BaseVer:  ch.BaseVersion,
	}); err != nil {
		return PushResult{}, err
	}
	return PushResult{ClientChangeID: ch.ClientChangeID, Status: "accepted", Version: newVer}, nil
}

// Pull 按游标增量拉取变更流，返回本页变更与下一游标。
func Pull(ctx context.Context, st store.Store, vaultID, cursor int64, limit int) ([]Change, int64, error) {
	rows, next, err := st.Pull(ctx, vaultID, cursor, limit)
	if err != nil {
		return nil, cursor, err
	}
	out := make([]Change, 0, len(rows))
	for _, c := range rows {
		out = append(out, Change{
			Seq:       c.ID,
			Path:      c.Path,
			Op:        c.Op,
			BlobHash:  c.BlobHash,
			Version:   c.Version,
			DeviceID:  c.DeviceID,
			CreatedAt: c.CreatedAt,
		})
	}
	return out, next, nil
}

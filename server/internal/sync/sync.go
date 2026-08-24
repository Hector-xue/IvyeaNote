// Package sync 实现同步核心：push 冲突判定/幂等去重、pull 增量游标。
// 协议契约见 shared/protocol.md。
package sync

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
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
func ApplyPush(ctx context.Context, tx pgx.Tx, vaultID, userID int64, deviceID string, ch PushChange) (PushResult, error) {
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
	var dup bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM changes WHERE device_id=$1 AND client_change_id=$2)`,
		deviceID, ch.ClientChangeID).Scan(&dup); err != nil {
		return PushResult{}, err
	}
	if dup {
		var ver int64
		var bh *string
		_ = tx.QueryRow(ctx,
			`SELECT version, blob_hash FROM heads WHERE vault_id=$1 AND path=$2`,
			vaultID, ch.Path).Scan(&ver, &bh)
		return PushResult{ClientChangeID: ch.ClientChangeID, Status: "accepted", Version: ver}, nil
	}

	// 冲突检测：base_version 必须等于服务端当前版本
	var curVer int64
	var curHash *string
	var curDeleted bool
	err := tx.QueryRow(ctx,
		`SELECT version, blob_hash, deleted FROM heads WHERE vault_id=$1 AND path=$2 FOR UPDATE`,
		vaultID, ch.Path).Scan(&curVer, &curHash, &curDeleted)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		curVer, curHash, curDeleted = 0, nil, false
	case err != nil:
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
		var known bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM blobs WHERE hash=$1 AND user_id=$2)`,
			*ch.BlobHash, userID).Scan(&known); err != nil {
			return PushResult{}, err
		}
		if !known {
			return reject(ch.ClientChangeID, "unknown_blob"), nil
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO heads(vault_id,path,version,blob_hash,deleted) VALUES($1,$2,$3,$4,FALSE)
			 ON CONFLICT (vault_id,path) DO UPDATE
			   SET version=EXCLUDED.version, blob_hash=EXCLUDED.blob_hash, deleted=FALSE`,
			vaultID, ch.Path, newVer, *ch.BlobHash); err != nil {
			return PushResult{}, err
		}
	} else {
		if _, err := tx.Exec(ctx,
			`INSERT INTO heads(vault_id,path,version,blob_hash,deleted) VALUES($1,$2,$3,NULL,TRUE)
			 ON CONFLICT (vault_id,path) DO UPDATE
			   SET version=EXCLUDED.version, blob_hash=NULL, deleted=TRUE`,
			vaultID, ch.Path, newVer); err != nil {
			return PushResult{}, err
		}
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO changes(vault_id,device_id,client_change_id,path,op,blob_hash,version,base_version)
		 VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
		vaultID, deviceID, ch.ClientChangeID, ch.Path, ch.Op, ch.BlobHash, newVer, ch.BaseVersion); err != nil {
		return PushResult{}, err
	}
	return PushResult{ClientChangeID: ch.ClientChangeID, Status: "accepted", Version: newVer}, nil
}

// Pull 按游标增量拉取变更流，返回本页变更与下一游标。
func Pull(ctx context.Context, pool *pgxpool.Pool, vaultID, cursor int64, limit int) ([]Change, int64, error) {
	rows, err := pool.Query(ctx,
		`SELECT id, path, op, blob_hash, version, device_id, created_at
		 FROM changes WHERE vault_id=$1 AND id>$2 ORDER BY id LIMIT $3`,
		vaultID, cursor, limit)
	if err != nil {
		return nil, cursor, err
	}
	defer rows.Close()

	out := make([]Change, 0, limit)
	next := cursor
	for rows.Next() {
		var c Change
		if err := rows.Scan(&c.Seq, &c.Path, &c.Op, &c.BlobHash, &c.Version, &c.DeviceID, &c.CreatedAt); err != nil {
			return nil, cursor, err
		}
		out = append(out, c)
		next = c.Seq
	}
	if err := rows.Err(); err != nil {
		return nil, cursor, err
	}
	return out, next, nil
}

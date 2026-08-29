// Package store：数据访问抽象（接口定义见 store.go）。
// 本文件：PostgreSQL 后端（pgxpool），SQL 从原 server.go/sync.go 平移。
package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Connect 创建并 ping PostgreSQL 连接池。
func ConnectPG(ctx context.Context, url string) (*PGStore, error) {
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, fmt.Errorf("parse db url: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		return nil, fmt.Errorf("ping db: %w", err)
	}
	return &PGStore{pool: pool}, nil
}

// PGStore PostgreSQL 实现。
type PGStore struct {
	pool *pgxpool.Pool
}

func (s *PGStore) Close() { s.pool.Close() }

func mapPGErr(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNoRows
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return ErrEmailExists
	}
	return err
}

var pgDDL = []string{
	`CREATE TABLE IF NOT EXISTS users (
		id            BIGSERIAL PRIMARY KEY,
		email         TEXT UNIQUE NOT NULL,
		password_hash TEXT NOT NULL,
		created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,
	`CREATE TABLE IF NOT EXISTS vaults (
		id         BIGSERIAL PRIMARY KEY,
		user_id    BIGINT NOT NULL REFERENCES users(id),
		name       TEXT NOT NULL,
		created_at TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,
	`CREATE TABLE IF NOT EXISTS devices (
		id         TEXT PRIMARY KEY,
		user_id    BIGINT NOT NULL REFERENCES users(id),
		created_at TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,
	`CREATE TABLE IF NOT EXISTS blobs (
		hash       TEXT NOT NULL,
		user_id    BIGINT NOT NULL REFERENCES users(id),
		size       BIGINT NOT NULL,
		content    BYTEA NOT NULL,
		created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
		PRIMARY KEY (hash, user_id)
	)`,
	`CREATE TABLE IF NOT EXISTS heads (
		vault_id  BIGINT NOT NULL,
		path      TEXT NOT NULL,
		version   BIGINT NOT NULL DEFAULT 0,
		blob_hash TEXT,
		deleted   BOOLEAN NOT NULL DEFAULT FALSE,
		PRIMARY KEY (vault_id, path)
	)`,
	`CREATE TABLE IF NOT EXISTS changes (
		id               BIGSERIAL PRIMARY KEY,
		vault_id         BIGINT NOT NULL,
		device_id        TEXT NOT NULL,
		client_change_id TEXT NOT NULL,
		path             TEXT NOT NULL,
		op               TEXT NOT NULL CHECK (op IN ('upsert','delete')),
		blob_hash        TEXT,
		version          BIGINT NOT NULL,
		base_version     BIGINT NOT NULL DEFAULT 0,
		created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
		UNIQUE (device_id, client_change_id)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_changes_vault ON changes (vault_id, id)`,
	`CREATE TABLE IF NOT EXISTS mcp_tokens (
		id           BIGSERIAL PRIMARY KEY,
		token_hash   TEXT NOT NULL UNIQUE,
		user_id      BIGINT NOT NULL REFERENCES users(id),
		name         TEXT NOT NULL DEFAULT '',
		prefix       TEXT NOT NULL DEFAULT '',
		created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
		last_used_at TIMESTAMPTZ
	)`,
	`CREATE TABLE IF NOT EXISTS refresh_tokens (
		token      TEXT PRIMARY KEY,
		user_id    BIGINT NOT NULL REFERENCES users(id),
		expires_at TIMESTAMPTZ NOT NULL,
		created_at TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,
}

// Migrate 幂等执行全部 DDL。
func (s *PGStore) Migrate(ctx context.Context) error {
	for i, stmt := range pgDDL {
		if _, err := s.pool.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("ddl %d: %w", i+1, err)
		}
	}
	return nil
}

// ---------- users ----------

func (s *PGStore) CreateUser(ctx context.Context, email, hash string) (int64, error) {
	var id int64
	err := s.pool.QueryRow(ctx,
		`INSERT INTO users(email, password_hash) VALUES($1,$2) RETURNING id`, email, hash).Scan(&id)
	if err != nil {
		return 0, mapPGErr(err)
	}
	return id, nil
}

func (s *PGStore) GetUserByEmail(ctx context.Context, email string) (*User, error) {
	var u User
	err := s.pool.QueryRow(ctx,
		`SELECT id, email, password_hash FROM users WHERE email=$1`, email).
		Scan(&u.ID, &u.Email, &u.PasswordHash)
	if err != nil {
		return nil, mapPGErr(err)
	}
	return &u, nil
}

func (s *PGStore) UpdatePasswordHash(ctx context.Context, userID int64, hash string) error {
	_, err := s.pool.Exec(ctx, `UPDATE users SET password_hash=$1 WHERE id=$2`, hash, userID)
	return err
}

// ---------- refresh tokens ----------

func (s *PGStore) CreateRefreshToken(ctx context.Context, token string, userID int64, expiresAt time.Time) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO refresh_tokens(token, user_id, expires_at) VALUES($1,$2,$3)`, token, userID, expiresAt)
	return err
}

func (s *PGStore) GetRefreshTokenUser(ctx context.Context, token string) (int64, error) {
	var uid int64
	err := s.pool.QueryRow(ctx,
		`SELECT user_id FROM refresh_tokens WHERE token=$1 AND expires_at>now()`, token).Scan(&uid)
	if err != nil {
		return 0, mapPGErr(err)
	}
	return uid, nil
}

func (s *PGStore) DeleteRefreshToken(ctx context.Context, token string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM refresh_tokens WHERE token=$1`, token)
	return err
}

// ---------- devices ----------

func (s *PGStore) CreateDevice(ctx context.Context, id string, userID int64) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO devices(id, user_id) VALUES($1,$2)`, id, userID)
	return mapPGErr(err)
}

// ---------- vaults ----------

func (s *PGStore) ListVaults(ctx context.Context, userID int64) ([]Vault, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, user_id, name, created_at FROM vaults WHERE user_id=$1 ORDER BY id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Vault{}
	for rows.Next() {
		var v Vault
		if err := rows.Scan(&v.ID, &v.UserID, &v.Name, &v.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *PGStore) CreateVault(ctx context.Context, userID int64, name string) (int64, error) {
	var id int64
	err := s.pool.QueryRow(ctx,
		`INSERT INTO vaults(user_id, name) VALUES($1,$2) RETURNING id`, userID, name).Scan(&id)
	if err != nil {
		return 0, err
	}
	return id, nil
}

func (s *PGStore) VaultOwnedBy(ctx context.Context, vaultID, userID int64) (bool, error) {
	var ok bool
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM vaults WHERE id=$1 AND user_id=$2)`, vaultID, userID).Scan(&ok)
	return ok, err
}

// ---------- blobs ----------

func (s *PGStore) PutBlob(ctx context.Context, hash string, userID int64, content []byte) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO blobs(hash, user_id, size, content) VALUES($1,$2,$3,$4)
		 ON CONFLICT (hash, user_id) DO NOTHING`,
		hash, userID, len(content), content)
	return err
}

func (s *PGStore) GetBlob(ctx context.Context, hash string, userID int64) ([]byte, error) {
	var content []byte
	err := s.pool.QueryRow(ctx,
		`SELECT content FROM blobs WHERE hash=$1 AND user_id=$2`, hash, userID).Scan(&content)
	if err != nil {
		return nil, mapPGErr(err)
	}
	return content, nil
}

func (s *PGStore) BlobExists(ctx context.Context, hash string, userID int64) (bool, error) {
	var ok bool
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM blobs WHERE hash=$1 AND user_id=$2)`, hash, userID).Scan(&ok)
	return ok, err
}

// ---------- 同步 ----------

func (s *PGStore) BeginTx(ctx context.Context) (Tx, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return &PGTx{tx: tx}, nil
}

func (s *PGStore) Pull(ctx context.Context, vaultID, cursor int64, limit int) ([]Change, int64, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, vault_id, device_id, client_change_id, path, op, blob_hash, version, base_version, created_at
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
		if err := rows.Scan(&c.ID, &c.VaultID, &c.DeviceID, &c.ClientID, &c.Path, &c.Op,
			&c.BlobHash, &c.Version, &c.BaseVer, &c.CreatedAt); err != nil {
			return nil, cursor, err
		}
		out = append(out, c)
		next = c.ID
	}
	return out, next, rows.Err()
}

// ---------- MCP 长期令牌 ----------

func (s *PGStore) CreateMCPToken(ctx context.Context, hash string, userID int64, name string) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO mcp_tokens(token_hash, user_id, name, prefix) VALUES($1,$2,$3,$4)`,
		hash, userID, name, mcpPrefix(hash))
	return mapPGErr(err)
}

func (s *PGStore) GetMCPTokenUser(ctx context.Context, hash string) (int64, error) {
	var uid int64
	err := s.pool.QueryRow(ctx, `SELECT user_id FROM mcp_tokens WHERE token_hash=$1`, hash).Scan(&uid)
	if err != nil {
		return 0, mapPGErr(err)
	}
	// 记一次使用时间；失败不影响鉴权
	_, _ = s.pool.Exec(ctx, `UPDATE mcp_tokens SET last_used_at=now() WHERE token_hash=$1`, hash)
	return uid, nil
}

func (s *PGStore) ListMCPTokens(ctx context.Context, userID int64) ([]MCPToken, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, name, prefix, created_at, last_used_at FROM mcp_tokens WHERE user_id=$1 ORDER BY id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MCPToken{}
	for rows.Next() {
		var t MCPToken
		var used *time.Time
		if err := rows.Scan(&t.ID, &t.Name, &t.Prefix, &t.CreatedAt, &used); err != nil {
			return nil, err
		}
		t.LastUsedAt = used
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *PGStore) DeleteMCPToken(ctx context.Context, userID, id int64) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM mcp_tokens WHERE id=$1 AND user_id=$2`, id, userID)
	if err != nil {
		return mapPGErr(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNoRows
	}
	return nil
}

// ListHeads 存活路径（未删除且有 blob）。
func (s *PGStore) ListHeads(ctx context.Context, vaultID int64) ([]Head, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT path, version, blob_hash FROM heads
		 WHERE vault_id=$1 AND deleted=false AND blob_hash IS NOT NULL ORDER BY path`, vaultID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Head{}
	for rows.Next() {
		h := Head{VaultID: vaultID}
		if err := rows.Scan(&h.Path, &h.Version, &h.BlobHash); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// PGTx 事务实现。
type PGTx struct {
	tx pgx.Tx
}

func (t *PGTx) HeadForUpdate(ctx context.Context, vaultID int64, path string) (*Head, error) {
	var h Head
	err := t.tx.QueryRow(ctx,
		`SELECT vault_id, path, version, blob_hash, deleted FROM heads WHERE vault_id=$1 AND path=$2 FOR UPDATE`,
		vaultID, path).Scan(&h.VaultID, &h.Path, &h.Version, &h.BlobHash, &h.Deleted)
	if err != nil {
		return nil, mapPGErr(err)
	}
	return &h, nil
}

func (t *PGTx) ChangeExists(ctx context.Context, deviceID, clientChangeID string) (bool, error) {
	var dup bool
	err := t.tx.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM changes WHERE device_id=$1 AND client_change_id=$2)`,
		deviceID, clientChangeID).Scan(&dup)
	return dup, err
}

func (t *PGTx) CurrentVersion(ctx context.Context, vaultID int64, path string) (int64, *string, error) {
	var ver int64
	var bh *string
	err := t.tx.QueryRow(ctx,
		`SELECT version, blob_hash FROM heads WHERE vault_id=$1 AND path=$2`,
		vaultID, path).Scan(&ver, &bh)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil, nil
		}
		return 0, nil, err
	}
	return ver, bh, nil
}

func (t *PGTx) UpsertHead(ctx context.Context, h Head) error {
	_, err := t.tx.Exec(ctx,
		`INSERT INTO heads(vault_id,path,version,blob_hash,deleted) VALUES($1,$2,$3,$4,$5)
		 ON CONFLICT (vault_id,path) DO UPDATE
		   SET version=EXCLUDED.version, blob_hash=EXCLUDED.blob_hash, deleted=EXCLUDED.deleted`,
		h.VaultID, h.Path, h.Version, h.BlobHash, h.Deleted)
	return err
}

func (t *PGTx) AppendChange(ctx context.Context, c *Change) error {
	return t.tx.QueryRow(ctx,
		`INSERT INTO changes(vault_id,device_id,client_change_id,path,op,blob_hash,version,base_version)
		 VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
		c.VaultID, c.DeviceID, c.ClientID, c.Path, c.Op, c.BlobHash, c.Version, c.BaseVer).Scan(&c.ID)
}

func (t *PGTx) BlobExists(ctx context.Context, hash string, userID int64) (bool, error) {
	var ok bool
	err := t.tx.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM blobs WHERE hash=$1 AND user_id=$2)`, hash, userID).Scan(&ok)
	return ok, err
}

func (t *PGTx) Commit() error   { return t.tx.Commit(context.Background()) }
func (t *PGTx) Rollback() error { return t.tx.Rollback(context.Background()) }

// ---------- H8：用户管理 ----------

func (s *PGStore) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, email, password_hash FROM users ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []User{}
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Email, &u.PasswordHash); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

func (s *PGStore) DeleteUser(ctx context.Context, userID int64) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// 逐表删除（无 ON DELETE CASCADE，按依赖顺序）
	for _, stmt := range []string{
		`DELETE FROM changes WHERE vault_id IN (SELECT id FROM vaults WHERE user_id=$1)`,
		`DELETE FROM heads WHERE vault_id IN (SELECT id FROM vaults WHERE user_id=$1)`,
		`DELETE FROM vaults WHERE user_id=$1`,
		`DELETE FROM blobs WHERE user_id=$1`,
		`DELETE FROM devices WHERE user_id=$1`,
		`DELETE FROM refresh_tokens WHERE user_id=$1`,
		`DELETE FROM users WHERE id=$1`,
	} {
		if _, err := tx.Exec(ctx, stmt, userID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *PGStore) UserBlobBytes(ctx context.Context, userID int64) (int64, error) {
	var n int64
	err := s.pool.QueryRow(ctx,
		`SELECT COALESCE(SUM(size),0) FROM blobs WHERE user_id=$1`, userID).Scan(&n)
	return n, err
}

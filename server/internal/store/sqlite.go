// SQLite 后端（modernc.org/sqlite 纯 Go 驱动，无 CGO）。
// 自托管单机首选：单文件数据库、零外部依赖。
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// ConnectSQLite 打开（必要时创建）SQLite 数据库文件。
// busy_timeout 应对并发写；WAL 提升读写并发。
func ConnectSQLite(ctx context.Context, path string) (*SQLiteStore, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(ON)")
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// modernc/sqlite 写并发受限：全局串行化写，读不受影响
	db.SetMaxOpenConns(1)
	if err := db.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}
	return &SQLiteStore{db: db}, nil
}

// SQLiteStore SQLite 实现。
// modernc 驱动对多连接写敏感，用互斥锁保护事务段，避免 SQL_BUSY。
type SQLiteStore struct {
	db *sql.DB
	mu sync.Mutex // 串行化 BeginTx（事务本身由单连接串行保证）
}

func (s *SQLiteStore) Close() { _ = s.db.Close() }

func mapSQLErr(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNoRows
	}
	if err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed: users.email") {
		return ErrEmailExists
	}
	return err
}

var sqliteDDL = []string{
	`CREATE TABLE IF NOT EXISTS users (
		id            INTEGER PRIMARY KEY AUTOINCREMENT,
		email         TEXT UNIQUE NOT NULL,
		password_hash TEXT NOT NULL,
		created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
	)`,
	`CREATE TABLE IF NOT EXISTS vaults (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id    INTEGER NOT NULL REFERENCES users(id),
		name       TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
	)`,
	`CREATE TABLE IF NOT EXISTS devices (
		id         TEXT PRIMARY KEY,
		user_id    INTEGER NOT NULL REFERENCES users(id),
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
	)`,
	`CREATE TABLE IF NOT EXISTS blobs (
		hash       TEXT NOT NULL,
		user_id    INTEGER NOT NULL REFERENCES users(id),
		size       INTEGER NOT NULL,
		content    BLOB NOT NULL,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
		PRIMARY KEY (hash, user_id)
	)`,
	`CREATE TABLE IF NOT EXISTS heads (
		vault_id  INTEGER NOT NULL,
		path      TEXT NOT NULL,
		version   INTEGER NOT NULL DEFAULT 0,
		blob_hash TEXT,
		deleted   INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (vault_id, path)
	)`,
	`CREATE TABLE IF NOT EXISTS changes (
		id               INTEGER PRIMARY KEY AUTOINCREMENT,
		vault_id         INTEGER NOT NULL,
		device_id        TEXT NOT NULL,
		client_change_id TEXT NOT NULL,
		path             TEXT NOT NULL,
		op               TEXT NOT NULL CHECK (op IN ('upsert','delete')),
		blob_hash        TEXT,
		version          INTEGER NOT NULL,
		base_version     INTEGER NOT NULL DEFAULT 0,
		created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
		UNIQUE (device_id, client_change_id)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_changes_vault ON changes (vault_id, id)`,
	`CREATE TABLE IF NOT EXISTS refresh_tokens (
		token      TEXT PRIMARY KEY,
		user_id    INTEGER NOT NULL REFERENCES users(id),
		expires_at TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
	)`,
}

// Migrate 幂等执行全部 DDL。
func (s *SQLiteStore) Migrate(ctx context.Context) error {
	for i, stmt := range sqliteDDL {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("ddl %d: %w", i+1, err)
		}
	}
	return nil
}

// ---------- users ----------

func (s *SQLiteStore) CreateUser(ctx context.Context, email, hash string) (int64, error) {
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO users(email, password_hash) VALUES(?,?)`, email, hash)
	if err != nil {
		return 0, mapSQLErr(err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}
	return id, nil
}

func (s *SQLiteStore) GetUserByEmail(ctx context.Context, email string) (*User, error) {
	var u User
	err := s.db.QueryRowContext(ctx,
		`SELECT id, email, password_hash FROM users WHERE email=?`, email).
		Scan(&u.ID, &u.Email, &u.PasswordHash)
	if err != nil {
		return nil, mapSQLErr(err)
	}
	return &u, nil
}

func (s *SQLiteStore) UpdatePasswordHash(ctx context.Context, userID int64, hash string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET password_hash=? WHERE id=?`, hash, userID)
	return err
}

// ---------- refresh tokens ----------

func (s *SQLiteStore) CreateRefreshToken(ctx context.Context, token string, userID int64, expiresAt time.Time) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO refresh_tokens(token, user_id, expires_at) VALUES(?,?,?)`,
		token, userID, expiresAt.UTC().Format(time.RFC3339Nano))
	return err
}

func (s *SQLiteStore) GetRefreshTokenUser(ctx context.Context, token string) (int64, error) {
	var uid int64
	err := s.db.QueryRowContext(ctx,
		`SELECT user_id FROM refresh_tokens WHERE token=? AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
		token).Scan(&uid)
	if err != nil {
		return 0, mapSQLErr(err)
	}
	return uid, nil
}

func (s *SQLiteStore) DeleteRefreshToken(ctx context.Context, token string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM refresh_tokens WHERE token=?`, token)
	return err
}

// ---------- devices ----------

func (s *SQLiteStore) CreateDevice(ctx context.Context, id string, userID int64) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO devices(id, user_id) VALUES(?,?)`, id, userID)
	return mapSQLErr(err)
}

// ---------- vaults ----------

func scanVault(scan func(dest ...any) error) (Vault, error) {
	var v Vault
	var created string
	if err := scan(&v.ID, &v.UserID, &v.Name, &created); err != nil {
		return v, err
	}
	if t, err := time.Parse(time.RFC3339Nano, created); err == nil {
		v.CreatedAt = t
	}
	return v, nil
}

func (s *SQLiteStore) ListVaults(ctx context.Context, userID int64) ([]Vault, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, user_id, name, created_at FROM vaults WHERE user_id=? ORDER BY id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Vault{}
	for rows.Next() {
		v, err := scanVault(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *SQLiteStore) CreateVault(ctx context.Context, userID int64, name string) (int64, error) {
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO vaults(user_id, name) VALUES(?,?)`, userID, name)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *SQLiteStore) VaultOwnedBy(ctx context.Context, vaultID, userID int64) (bool, error) {
	var ok bool
	err := s.db.QueryRowContext(ctx,
		`SELECT EXISTS(SELECT 1 FROM vaults WHERE id=? AND user_id=?)`, vaultID, userID).Scan(&ok)
	return ok, err
}

// ---------- blobs ----------

func (s *SQLiteStore) PutBlob(ctx context.Context, hash string, userID int64, content []byte) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO blobs(hash, user_id, size, content) VALUES(?,?,?,?)
		 ON CONFLICT (hash, user_id) DO NOTHING`,
		hash, userID, len(content), content)
	return err
}

func (s *SQLiteStore) GetBlob(ctx context.Context, hash string, userID int64) ([]byte, error) {
	var content []byte
	err := s.db.QueryRowContext(ctx,
		`SELECT content FROM blobs WHERE hash=? AND user_id=?`, hash, userID).Scan(&content)
	if err != nil {
		return nil, mapSQLErr(err)
	}
	return content, nil
}

func (s *SQLiteStore) BlobExists(ctx context.Context, hash string, userID int64) (bool, error) {
	var ok bool
	err := s.db.QueryRowContext(ctx,
		`SELECT EXISTS(SELECT 1 FROM blobs WHERE hash=? AND user_id=?)`, hash, userID).Scan(&ok)
	return ok, err
}

// ---------- 同步 ----------

func (s *SQLiteStore) BeginTx(ctx context.Context) (Tx, error) {
	s.mu.Lock() // 串行化事务：modernc 单写者模型
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}
	return &SQLiteTx{store: s, tx: tx}, nil
}

func (s *SQLiteStore) Pull(ctx context.Context, vaultID, cursor int64, limit int) ([]Change, int64, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, vault_id, device_id, client_change_id, path, op, blob_hash, version, base_version, created_at
		 FROM changes WHERE vault_id=? AND id>? ORDER BY id LIMIT ?`,
		vaultID, cursor, limit)
	if err != nil {
		return nil, cursor, err
	}
	defer rows.Close()
	out := make([]Change, 0, limit)
	next := cursor
	for rows.Next() {
		var c Change
		var created string
		if err := rows.Scan(&c.ID, &c.VaultID, &c.DeviceID, &c.ClientID, &c.Path, &c.Op,
			&c.BlobHash, &c.Version, &c.BaseVer, &created); err != nil {
			return nil, cursor, err
		}
		if t, err := time.Parse(time.RFC3339Nano, created); err == nil {
			c.CreatedAt = t
		}
		out = append(out, c)
		next = c.ID
	}
	return out, next, rows.Err()
}

// SQLiteTx 事务实现。
type SQLiteTx struct {
	store *SQLiteStore
	tx    *sql.Tx
	done  bool
}

func (t *SQLiteTx) HeadForUpdate(ctx context.Context, vaultID int64, path string) (*Head, error) {
	var h Head
	var deleted int
	var bh sql.NullString
	err := t.tx.QueryRowContext(ctx,
		`SELECT vault_id, path, version, blob_hash, deleted FROM heads WHERE vault_id=? AND path=?`,
		vaultID, path).Scan(&h.VaultID, &h.Path, &h.Version, &bh, &deleted)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNoRows
		}
		return nil, err
	}
	h.Deleted = deleted != 0
	if bh.Valid {
		v := bh.String
		h.BlobHash = &v
	}
	return &h, nil
}

func (t *SQLiteTx) ChangeExists(ctx context.Context, deviceID, clientChangeID string) (bool, error) {
	var dup bool
	err := t.tx.QueryRowContext(ctx,
		`SELECT EXISTS(SELECT 1 FROM changes WHERE device_id=? AND client_change_id=?)`,
		deviceID, clientChangeID).Scan(&dup)
	return dup, err
}

func (t *SQLiteTx) CurrentVersion(ctx context.Context, vaultID int64, path string) (int64, *string, error) {
	var ver int64
	var bh sql.NullString
	err := t.tx.QueryRowContext(ctx,
		`SELECT version, blob_hash FROM heads WHERE vault_id=? AND path=?`,
		vaultID, path).Scan(&ver, &bh)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, nil, nil
		}
		return 0, nil, err
	}
	if bh.Valid {
		v := bh.String
		return ver, &v, nil
	}
	return ver, nil, nil
}

func (t *SQLiteTx) UpsertHead(ctx context.Context, h Head) error {
	deleted := 0
	if h.Deleted {
		deleted = 1
	}
	var bh any
	if h.BlobHash != nil {
		bh = *h.BlobHash
	}
	_, err := t.tx.ExecContext(ctx,
		`INSERT INTO heads(vault_id,path,version,blob_hash,deleted) VALUES(?,?,?,?,?)
		 ON CONFLICT (vault_id,path) DO UPDATE SET
		   version=excluded.version, blob_hash=excluded.blob_hash, deleted=excluded.deleted`,
		h.VaultID, h.Path, h.Version, bh, deleted)
	return err
}

func (t *SQLiteTx) AppendChange(ctx context.Context, c *Change) error {
	var bh any
	if c.BlobHash != nil {
		bh = *c.BlobHash
	}
	res, err := t.tx.ExecContext(ctx,
		`INSERT INTO changes(vault_id,device_id,client_change_id,path,op,blob_hash,version,base_version)
		 VALUES(?,?,?,?,?,?,?,?)`,
		c.VaultID, c.DeviceID, c.ClientID, c.Path, c.Op, bh, c.Version, c.BaseVer)
	if err != nil {
		return err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return err
	}
	c.ID = id
	return nil
}

func (t *SQLiteTx) BlobExists(ctx context.Context, hash string, userID int64) (bool, error) {
	var ok bool
	err := t.tx.QueryRowContext(ctx,
		`SELECT EXISTS(SELECT 1 FROM blobs WHERE hash=? AND user_id=?)`, hash, userID).Scan(&ok)
	return ok, err
}

func (t *SQLiteTx) Commit() error {
	if t.done {
		return nil
	}
	t.done = true
	err := t.tx.Commit()
	t.store.mu.Unlock()
	return err
}

func (t *SQLiteTx) Rollback() error {
	if t.done {
		return nil
	}
	t.done = true
	err := t.tx.Rollback()
	t.store.mu.Unlock()
	return err
}

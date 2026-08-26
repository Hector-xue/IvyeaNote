// Package store：数据访问抽象。
// H1（v0.6.0）：引入 Store 接口，支持 PostgreSQL（pgxpool）与 SQLite（modernc 纯 Go 驱动）
// 双后端——自托管单机场景用 SQLite 零依赖起步，多用户/大规模可切 PostgreSQL。
//
// 设计约定：
//   - 接口只暴露 api/sync 层实际用到的方法（从现有 SQL 调用点归纳）
//   - 错误语义：记录不存在统一返回 ErrNoRows（两后端各自映射）
//   - 唯一约束冲突统一返回 ErrEmailExists（注册场景）
package store

import (
	"context"
	"errors"
	"time"
)

var (
	ErrNoRows      = errors.New("store: no rows")
	ErrEmailExists = errors.New("store: email already exists")
)

// User 账号行。
type User struct {
	ID           int64
	Email        string
	PasswordHash string
}

// Vault 库行。
type Vault struct {
	ID        int64
	UserID    int64
	Name      string
	CreatedAt time.Time
}

// Change 同步变更流行。
type Change struct {
	ID        int64
	VaultID   int64
	DeviceID  string
	ClientID  string
	Path      string
	Op        string
	BlobHash  *string
	Version   int64
	BaseVer   int64
	CreatedAt time.Time
}

// Head 某路径的当前版本指针。
type Head struct {
	VaultID  int64
	Path     string
	Version  int64
	BlobHash *string
	Deleted  bool
}

// Blob 内容寻址存储行。
type Blob struct {
	Hash      string
	UserID    int64
	Size      int
	CreatedAt time.Time
}

// Store 全部数据访问。
type Store interface {
	// Close 关闭底层连接。
	Close()

	// ---------- users ----------
	CreateUser(ctx context.Context, email, passwordHash string) (int64, error)
	GetUserByEmail(ctx context.Context, email string) (*User, error)
	UpdatePasswordHash(ctx context.Context, userID int64, hash string) error

	// ---------- refresh tokens ----------
	CreateRefreshToken(ctx context.Context, token string, userID int64, expiresAt time.Time) error
	GetRefreshTokenUser(ctx context.Context, token string) (int64, error) // 过期视为不存在
	DeleteRefreshToken(ctx context.Context, token string) error

	// ---------- devices ----------
	CreateDevice(ctx context.Context, id string, userID int64) error

	// ---------- vaults ----------
	ListVaults(ctx context.Context, userID int64) ([]Vault, error)
	CreateVault(ctx context.Context, userID int64, name string) (int64, error)
	VaultOwnedBy(ctx context.Context, vaultID, userID int64) (bool, error)

	// ---------- blobs ----------
	PutBlob(ctx context.Context, hash string, userID int64, content []byte) error // 幂等
	GetBlob(ctx context.Context, hash string, userID int64) ([]byte, error)
	BlobExists(ctx context.Context, hash string, userID int64) (bool, error)

	// ---------- 同步（heads + changes） ----------
	// BeginTx 开启事务；返回的 Tx 传给 Sync 方法族。
	BeginTx(ctx context.Context) (Tx, error)
	// Pull 按游标增量拉取某库的变更流。
	Pull(ctx context.Context, vaultID, cursor int64, limit int) ([]Change, int64, error)
}

// Tx 事务内操作（push 路径需要原子性）。
type Tx interface {
	// HeadForUpdate 读取路径当前版本指针（不存在返回 ErrNoRows）。
	HeadForUpdate(ctx context.Context, vaultID int64, path string) (*Head, error)
	// ChangeExists 幂等检查：同 (device, clientChangeID) 是否已提交。
	ChangeExists(ctx context.Context, deviceID, clientChangeID string) (bool, error)
	// CurrentVersion 读取当前版本号与 blob（不存在返回 version=0）。
	CurrentVersion(ctx context.Context, vaultID int64, path string) (version int64, blobHash *string, err error)
	// BlobExists 事务内检查 blob 是否已上传（upsert 前置校验）。
	BlobExists(ctx context.Context, hash string, userID int64) (bool, error)
	// UpsertHead 写入新版本指针。
	UpsertHead(ctx context.Context, h Head) error
	// AppendChange 追加变更流，返回自增 id。
	AppendChange(ctx context.Context, c *Change) error
	Commit() error
	Rollback() error
}

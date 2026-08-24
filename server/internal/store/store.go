// Package store 负责 Postgres 连接与幂等迁移。
package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Connect 创建并 ping 数据库连接池。
func Connect(ctx context.Context, url string) (*pgxpool.Pool, error) {
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, fmt.Errorf("parse db url: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		return nil, fmt.Errorf("ping db: %w", err)
	}
	return pool, nil
}

var ddl = []string{
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
	`CREATE TABLE IF NOT EXISTS refresh_tokens (
		token      TEXT PRIMARY KEY,
		user_id    BIGINT NOT NULL REFERENCES users(id),
		expires_at TIMESTAMPTZ NOT NULL,
		created_at TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,
}

// Migrate 幂等执行全部 DDL。
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	for i, stmt := range ddl {
		if _, err := pool.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("ddl %d: %w", i+1, err)
		}
	}
	return nil
}

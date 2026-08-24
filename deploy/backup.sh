#!/usr/bin/env bash
# Ivyea Note 每日备份：pg_dump + 保留策略清理
# 由 crontab 调用，例如每天 03:30：
#   30 3 * * * /root/ivyea\ note/deploy/backup.sh >> /var/log/ivnote-backup.log 2>&1
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/ivyea-note}"
KEEP_DAYS="${KEEP_DAYS:-30}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"

echo "[$(date -Is)] 开始备份"
docker compose -f "/root/ivyea note/deploy/docker-compose.yml" exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-ivnote}" "${POSTGRES_DB:-ivnote}" \
  | gzip > "$BACKUP_DIR/ivnote-$STAMP.sql.gz"

echo "[$(date -Is)] 清理 ${KEEP_DAYS} 天前的旧备份"
find "$BACKUP_DIR" -name 'ivnote-*.sql.gz' -mtime "+$KEEP_DAYS" -delete

echo "[$(date -Is)] 备份完成: $BACKUP_DIR/ivnote-$STAMP.sql.gz ($(du -h "$BACKUP_DIR/ivnote-$STAMP.sql.gz" | cut -f1))"

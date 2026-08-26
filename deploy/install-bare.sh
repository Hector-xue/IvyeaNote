#!/usr/bin/env bash
# Ivyea Note 裸机一键安装（SQLite 模式，无需 Docker / PostgreSQL）
# 用法：sudo bash install-bare.sh
#   - 自动下载对应平台的 ivnote-server 二进制（或用本地已编译的）
#   - 自动生成 JWT 密钥与管理员密码
#   - 注册 systemd 服务（开机自启）
#   - 完成后在桌面生成「IvyeaNote-账号.txt」
set -euo pipefail

INSTALL_DIR="/opt/ivyea-note"
DATA_DIR="/opt/ivyea-note/data"
SERVICE_NAME="ivnote-server"
REPO="Hector-xue/IvyeaNote"

[[ $EUID -eq 0 ]] || { echo "请用 root 运行：sudo bash $0"; exit 1; }

echo "════════════════════════════════════"
echo "  Ivyea Note 裸机安装（SQLite 模式）"
echo "════════════════════════════════════"

# ---------- 1) 获取服务端二进制 ----------
mkdir -p "$INSTALL_DIR" "$DATA_DIR"
BIN="$INSTALL_DIR/ivnote-server"

if [[ -x "$BIN" ]]; then
  echo "① 已存在 $BIN（如需更新请先删除该文件重新运行）"
else
  echo "① 下载服务端…"
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64)  GOARCH="amd64" ;;
    aarch64|arm64) GOARCH="arm64" ;;
    *) echo "不支持的架构: $ARCH（可自行编译：cd server && go build -o ivnote-server ./cmd/ivnote-server）"; exit 1 ;;
  esac
  # 优先用同目录已编译产物（开发者场景），否则从 GitHub Release 拉最新
  LOCAL_BIN="$(dirname "$0")/../server/ivnote-server"
  if [[ -x "$LOCAL_BIN" ]]; then
    cp "$LOCAL_BIN" "$BIN"
    echo "   使用本地编译产物"
  else
    URL="https://github.com/${REPO}/releases/latest/download/ivnote-server_linux_${GOARCH}.tar.gz"
    if command -v curl >/dev/null; then
      curl -fsSL "$URL" | tar -xz -C "$INSTALL_DIR" ivnote-server || { echo "下载失败：$URL"; echo "可手动编译后放到 $LOCAL_BIN 重试"; exit 1; }
    else
      wget -qO- "$URL" | tar -xz -C "$INSTALL_DIR" ivnote-server || { echo "下载失败"; exit 1; }
    fi
    chmod +x "$BIN"
  fi
fi

# ---------- 2) 生成配置（仅首次） ----------
if [[ ! -f "$DATA_DIR/.configured" ]]; then
  echo "② 生成配置…"
  # 注意：不用 `tr | head` 组合——pipefail 下 tr 会因 SIGPIPE 退出 141
  ADMINPW=$(head -c 64 /dev/urandom | tr -dc 'a-zA-Z0-9' | head -c 16 || true)
  cat > "$DATA_DIR/.configured" <<EOF
IVNOTE_ADMIN_EMAIL=${IVNOTE_ADMIN_EMAIL:-admin@example.com}
IVNOTE_ADMIN_PASSWORD=$ADMINPW
EOF
  chmod 600 "$DATA_DIR/.configured"
else
  echo "② 沿用已有配置"
  ADMINPW=$(grep IVNOTE_ADMIN_PASSWORD "$DATA_DIR/.configured" | cut -d= -f2)
fi
ADMIN_EMAIL=$(grep IVNOTE_ADMIN_EMAIL "$DATA_DIR/.configured" | cut -d= -f2)

# ---------- 3) systemd 服务 ----------
echo "③ 注册 systemd 服务…"
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Ivyea Note Sync Server
After=network.target

[Service]
ExecStart=${BIN}
Environment=IVNOTE_DATA_DIR=${DATA_DIR}
Environment=IVNOTE_LISTEN=:8080
EnvironmentFile=${DATA_DIR}/.configured
Restart=on-failure
User=root

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME" 2>/dev/null || systemctl restart "$SERVICE_NAME"

# ---------- 4) 健康检查 ----------
echo "④ 等待服务就绪…"
READY=0
for i in $(seq 1 15); do
  if curl -fsS "http://127.0.0.1:8080/healthz" >/dev/null 2>&1; then READY=1; break; fi
  sleep 1
done
[[ $READY -eq 1 ]] && echo "   服务健康 ✓" || echo "   (服务启动中，稍后访问 http://127.0.0.1:8080/healthz 验证)"

# ---------- 5) 账号文件 ----------
# 本机 IP 提示（手机同 WiFi 可连）
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
ACC="Ivyea Note 登录信息（请妥善保管）
=============================================

服务器地址（本机）: http://127.0.0.1:8080
${LOCAL_IP:+服务器地址（手机/其他电脑，同一 WiFi）: http://${LOCAL_IP}:8080}
账号: ${ADMIN_EMAIL}
密码: ${ADMINPW}

使用方法:
1) 打开 Ivyea Note 客户端
2) 登录页点「导入账号文件」，选择本文件
3) 点登录，开始记笔记

说明:
- 手机连同一 WiFi 时用第二个地址即可同步
- 想从外网访问：推荐 Cloudflare Tunnel（免费，自带 HTTPS），见项目文档
- 数据库文件: ${DATA_DIR}/ivnote.db（备份它 = 备份全部数据）"

TARGET=""
for d in "/root/Desktop" "${HOME:-}/Desktop" /home/*/Desktop; do
  [[ -d "$d" && -w "$d" ]] && { TARGET="$d"; break; }
done
[[ -z "$TARGET" ]] && TARGET="$INSTALL_DIR"
printf '%s\n' "$ACC" > "$TARGET/IvyeaNote-账号.txt"

echo ""
echo "✅ 安装完成！"
echo "   服务状态: systemctl status $SERVICE_NAME"
echo "   📄 账号文件: $TARGET/IvyeaNote-账号.txt"

# ---------- 6) 可选：每日备份 cron（IVNOTE_ENABLE_BACKUP=1 开启） ----------
if [[ "${IVNOTE_ENABLE_BACKUP:-0}" == "1" ]]; then
  echo "⑤ 配置每日备份…"
  BACKUP_DIR="/opt/ivyea-note/backups"
  mkdir -p "$BACKUP_DIR"
  cat > /etc/cron.d/ivnote-backup <<CRON
# Ivyea Note 每日 03:00 备份（保留 14 份）
0 3 * * * root cp "$DATA_DIR/ivnote.db" "$BACKUP_DIR/ivnote-\$(date +\%Y\%m\%d).db" && ls -t "$BACKUP_DIR"/ivnote-*.db | tail -n +15 | xargs -r rm -f
CRON
  chmod 644 /etc/cron.d/ivnote-backup
  echo "   每日 03:00 备份到 $BACKUP_DIR（保留 14 天）"
fi

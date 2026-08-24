#!/usr/bin/env bash
# Ivyea Note 一键部署脚本（在 deploy/ 目录内执行：sudo ./install.sh）
#
# 部署完成后自动生成「IvyeaNote-账号.txt」：
#   - 检测到桌面目录（本机部署）→ 直接放到桌面
#   - 无桌面的 VPS → 放到 deploy/ 目录并打印绝对路径
set -euo pipefail
cd "$(dirname "$0")"

[[ $EUID -eq 0 ]] || { echo "请用 root 运行"; exit 1; }
command -v docker >/dev/null || { echo "未安装 Docker"; exit 1; }
docker compose version >/dev/null || { echo "未安装 Docker Compose v2+"; exit 1; }

# ---------- 1) 准备 .env：首次运行自动生成全部密钥与管理员密码 ----------
# 管理员密码由本脚本生成并写入 .env（而不是只打印在容器日志里），
# 这样部署完就能直接把账号密码写进账号文件给用户。
if [[ ! -f .env ]]; then
  cp .env.example .env
  SECRET=$(openssl rand -hex 32)
  PGPW=$(openssl rand -hex 16)
  ADMINPW=$(openssl rand -hex 8)   # 16 位字母数字，无特殊字符、方便手输
  sed -i "s|change-me-to-a-long-random-string|${SECRET}|;
          s|change-me-too|${PGPW}|;
          s|^IVNOTE_ADMIN_PASSWORD=.*|IVNOTE_ADMIN_PASSWORD=${ADMINPW}|;
          s|note.example.com|${IVNOTE_DOMAIN:-}|g" .env
  echo "已生成 .env（已含随机管理员密码）。域名不是环境变量 IVNOTE_DOMAIN 时，请编辑 deploy/.env 后重新运行。"
fi

# 以 .env 为准读取管理员配置（部署者可能手动改过）
get_env() { grep -E "^$1=" .env | head -1 | cut -d= -f2-; }
ADMIN_EMAIL=$(get_env IVNOTE_ADMIN_EMAIL); ADMIN_EMAIL=${ADMIN_EMAIL:-admin@example.com}
ADMIN_PASSWORD=$(get_env IVNOTE_ADMIN_PASSWORD)
DOMAIN=$(get_env IVNOTE_DOMAIN)

# ---------- 2) 启动 ----------
docker compose up -d --build
echo
echo "✅ 部署完成。健康检查："
sleep 3
curl -s "http://127.0.0.1:8080/healthz" >/dev/null 2>&1 \
  && echo "   服务健康 ✓" \
  || echo "   (端口暂未就绪或仅容器内可达；稍后访问 https://${DOMAIN:-你的域名}/healthz 验证)"

# ---------- 3) 生成账号文件 ----------
SERVER_URL="http://127.0.0.1:8080"
[[ -n "$DOMAIN" ]] && SERVER_URL="https://${DOMAIN}"

ACC="Ivyea Note 登录信息（请妥善保管）
=============================================

服务器地址: ${SERVER_URL}
账号: ${ADMIN_EMAIL}
密码: ${ADMIN_PASSWORD:-（见下方说明）}

使用方法:
1) 打开 Ivyea Note 客户端（开始菜单 / 应用列表里找 Ivyea Note）
2) 在登录页点「导入账号文件」，选择本文件，三栏自动填好
3) 点登录，开始记笔记

说明:
- 「服务器地址」= 你的笔记服务所在位置。本机部署且没配域名时就是 http://127.0.0.1:8080；
  配了域名（如 VPS 部署）就是 https://你的域名。
- 想改密码：编辑 deploy/.env 里的 IVNOTE_ADMIN_PASSWORD，然后重新运行部署脚本。"
if [[ -z "$ADMIN_PASSWORD" ]]; then
  ACC+="
⚠ 你把密码留空了：本次的初始密码在容器日志里（docker compose logs app 查看「初始密码」）。
  建议在 .env 设置 IVNOTE_ADMIN_PASSWORD 固定密码后重新运行本脚本。"
fi

TARGET=""
for d in "/root/Desktop" "${HOME:-}/Desktop" /home/*/Desktop; do
  [[ -d "$d" && -w "$d" ]] && { TARGET="$d"; break; }
done
if [[ -n "$TARGET" ]]; then
  printf '%s\n' "$ACC" > "$TARGET/IvyeaNote-账号.txt"
  echo
  echo "📄 账号文件已放到桌面: $TARGET/IvyeaNote-账号.txt"
else
  printf '%s\n' "$ACC" > "./IvyeaNote-账号.txt"
  echo
  echo "📄 账号文件已生成: $(pwd)/IvyeaNote-账号.txt （当前机器没有桌面目录）"
fi

# TLS 由宿主 nginx 终结（本栈不自带反代）。首次部署到新域名时：
#   1) 先在 /etc/nginx/conf.d/<域名>.conf 放 80 端口配置（ACME 路径 + 301），reload 后：
#   2) certbot certonly --webroot -w /var/www/html -d "${DOMAIN}"
#   3) 再补回 443 反代块（proxy_pass http://127.0.0.1:8080，含 WS Upgrade 头）并 reload。

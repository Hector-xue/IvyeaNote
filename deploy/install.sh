#!/usr/bin/env bash
# Ivyea Note 一键部署脚本（在 deploy/ 目录内执行）
set -euo pipefail
cd "$(dirname "$0")"

[[ $EUID -eq 0 ]] || { echo "请用 root 运行"; exit 1; }
command -v docker >/dev/null || { echo "未安装 Docker"; exit 1; }
docker compose version >/dev/null || { echo "未安装 Docker Compose v2+"; exit 1; }

if [[ ! -f .env ]]; then
  cp .env.example .env
  SECRET=$(openssl rand -hex 32)
  PGPW=$(openssl rand -hex 16)
  sed -i "s|change-me-to-a-long-random-string|${SECRET}|; s|change-me-too|${PGPW}|; s|note.example.com|${IVNOTE_DOMAIN:-}|g" .env
  echo "已生成 .env。若域名不是环境变量 IVNOTE_DOMAIN，请手动编辑 deploy/.env 后重新运行。"
fi

docker compose up -d --build
echo
echo "✅ 部署完成。健康检查："
sleep 3
curl -s "http://127.0.0.1:8080/healthz" 2>/dev/null || echo "(app 端口仅容器网络内可达，属正常；请访问 https://${IVNOTE_DOMAIN:-你的域名}/healthz 验证)"

# TLS 由宿主 nginx 终结（本栈不自带反代）。首次部署到新域名时：
#   1) 先在 /etc/nginx/conf.d/<域名>.conf 放 80 端口配置（ACME 路径 + 301），reload 后：
#   2) certbot certonly --webroot -w /var/www/html -d "${IVNOTE_DOMAIN}"
#   3) 再补回 443 反代块（proxy_pass http://127.0.0.1:8080，含 WS Upgrade 头）并 reload。

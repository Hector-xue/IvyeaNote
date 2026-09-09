#!/usr/bin/env bash
#
# 开源产物里不许出现任何**私有服务器地址**——域名或裸 IP。
#
# # 为什么要有它
#
# v0.10.3 把作者自己的 note.ivyea.com 写死成了所有构建的默认值，于是公开 Release 的
# 每个安装包，登录页底下都挂着别人的私有服务器地址——发版之后才被用户发现。
# 单测只能守住 `defaultServerUrl()` 的返回值，守不住"有人换个地方又写死一次"。
#
# # 这一版比原来严在哪
#
# 原来那条检查只扫 `dist/assets/*.js`，而且只认 `*.ivyea.*` / `*.example.*` 这个形状。
# 三个洞：
#   ① **Rust 侧**和 **tauri.conf.json** 不在扫描范围里——而更新服务器地址正是写在
#      tauri.conf.json 的 `plugins.updater.endpoints`，那里写死一个私有域名，
#      每台装了这个包的机器都会去连它；
#   ② **裸 IP** 完全不管（`https://170.106.83.241:8080` 一路绿灯）；
#   ③ 换个域名后缀（`.net` / `.cn` / 自建 TLD）也认不出来。
#
# 所以改成**白名单**：我们自己写的每一行代码里，出现的主机必须在名单上；
# 产物里再按"公网 IP + 可疑域名"扫一遍。名单短、且每一条都写得出理由——
# 这比"黑名单匹配某几个后缀"能守住的多。
#
# 用法：scripts/check-no-private-host.sh [产物目录] [--require-dist]
#   产物目录按**调用时的当前目录**解析（CI 里是 desktop/，本地可能是仓库根）。
#   `--require-dist`：产物目录不存在就直接判失败——CI 用它，因为那时 build 一定跑过。
#   不给这个开关时找不到产物只警告：本地没 build 过也该能扫源码。
# 退出码非 0 = 有可疑地址。私有构建（自己传 VITE_DEFAULT_SERVER）应跳过本检查。

set -euo pipefail

# ⚠️ **先把产物目录解析成绝对路径，再 cd 到仓库根。**
# 反过来写的话，CI 里 `bash ../scripts/check.sh dist`（工作目录是 desktop/）会把
# `dist` 当成仓库根下的 dist——那个目录不存在，于是产物扫描被静默跳过、
# 闸门永远绿灯。这类"看着在跑、其实什么都没查"的检查比没有还糟。
REQUIRE_DIST=0
DIST_ARG=""
for arg in "$@"; do
  case "$arg" in
    --require-dist) REQUIRE_DIST=1 ;;
    *) DIST_ARG="$arg" ;;
  esac
done
if [ -n "$DIST_ARG" ]; then
  DIST="$(cd "$(dirname "$DIST_ARG")" 2>/dev/null && pwd)/$(basename "$DIST_ARG")" || DIST="$DIST_ARG"
else
  DIST=""
fi
cd "$(dirname "$0")/.."
# 没指定就自己找：仓库根的 dist 或 desktop/dist
if [ -z "$DIST" ]; then
  for cand in desktop/dist dist; do
    [ -d "$cand" ] && DIST="$PWD/$cand" && break
  done
fi

if [ -n "${VITE_DEFAULT_SERVER:-}" ]; then
  echo "设置了 VITE_DEFAULT_SERVER，跳过（私有构建本来就该指向自己的服务器）"
  exit 0
fi

fail=0

# ---------- 允许出现的主机 ----------
# 每一条都要说得出理由，加新条目前先问一句"它凭什么进安装包"。
# `192.168.x.x` 是界面上教用户"手机该填哪个地址"的**占位文本**，不是主机名。
# `example.com/net/org` 与 `.test` 是 RFC 2606 保留给文档用的，子域一并放行——
# 它们不可能是任何人的私有服务器，而占位示例又确实需要一个像样的地址。
ALLOWED_HOSTS='^(localhost|127\.0\.0\.1|0\.0\.0\.0|255\.255\.255\.255|tauri\.localhost|github\.com|api\.github\.com|objects\.githubusercontent\.com|schema\.tauri\.app|(www\.)?w3\.org|([a-z0-9-]+\.)*example\.(com|org|net|test)|a\.com|x\.com|192\.168\.x\.x)$'
# 允许出现的裸 IP：回环、任意地址、广播、私网（RFC1918 / CGNAT / link-local），
# 外加 8.8.8.8——`localserver.rs` 用 **UDP connect** 到它来问"本机出网走哪块网卡"，
# 这个操作不发任何数据包，也不需要网络可达（换成私网地址就问不出正确答案）。
ALLOWED_IPS='^(0\.0\.0\.0|127\.|255\.255\.255\.255|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|8\.8\.8\.8$)'

# ---------- ① 我们自己写的源码 ----------
# 测试文件排除：那里的 https://a.com、192.168.1.5 是**用例数据**，不进产物。
src_files=$(
  { find desktop/src-tauri/src desktop/src-tauri/plugins -name '*.rs' 2>/dev/null
    find desktop/src -name '*.ts' -o -name '*.tsx' 2>/dev/null
    ls desktop/src-tauri/tauri.conf.json desktop/src-tauri/capabilities/*.json 2>/dev/null
  } | grep -vE '\.(test|spec)\.(ts|tsx)$' || true
)

for f in $src_files; do
  # http(s):// 后面那一段主机名
  while read -r host; do
    [ -z "$host" ] && continue
    if ! echo "$host" | grep -qE "$ALLOWED_HOSTS"; then
      echo "::error file=$f::出现了不在白名单里的主机：$host"
      fail=1
    fi
  done < <(grep -ahoE 'https?://[a-zA-Z0-9._-]+' "$f" 2>/dev/null | sed -E 's#https?://##' | sort -u)

  # 裸 IPv4（含注释里的）——注释里写私网示例没问题，写公网地址就要说清楚
  while read -r ip; do
    [ -z "$ip" ] && continue
    if ! echo "$ip" | grep -qE "$ALLOWED_IPS"; then
      echo "::error file=$f::出现了公网 IP：$ip（安装包不该指向任何人的私有服务器）"
      fail=1
    fi
  done < <(grep -ahoE '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b' "$f" 2>/dev/null | sort -u)
done

# ---------- ② 构建产物 ----------
# ⚠️ **必须带 `-a`。** 压缩后的 bundle 里混着非文本字节，GNU grep 会把它判成
# 二进制文件，而二进制文件配上 `-o` 是**一个字都不输出**的——原来那条闸门
# 正是这么瞎掉的：它一直在跑、一直报"产物干净"，而往 dist 里塞一个私有域名
# 它也发现不了（2026-09-09 实测）。
# 产物里混着第三方库的字符串，白名单会一片红，所以这里按"可疑形状"扫：
# 私有域名（任意 TLD 的 ivyea/example 子域）+ 公网 IP。
if ls "$DIST"/assets/*.js >/dev/null 2>&1; then
  hits=$(grep -rahoE '(https?://)?[a-z0-9-]+\.(ivyea|example)\.[a-z]{2,}' "$DIST"/assets/*.js 2>/dev/null \
         | grep -v 'example\.com' | sort -u || true)
  if [ -n "$hits" ]; then
    echo "::error::构建产物里出现了硬编码域名——开源安装包不该指向任何人的私有服务器："
    echo "$hits"
    fail=1
  fi
  ips=$(grep -rahoE '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b' "$DIST"/assets/*.js 2>/dev/null | sort -u || true)
  for ip in $ips; do
    if ! echo "$ip" | grep -qE "$ALLOWED_IPS"; then
      echo "::error::构建产物里出现了公网 IP：$ip"
      fail=1
    fi
  done
elif [ "$REQUIRE_DIST" -eq 1 ]; then
  echo "::error::没找到构建产物（$DIST/assets/*.js）。这一步要求先 build——"
  echo "         静默跳过等于闸门失效，所以这里直接判失败。"
  fail=1
else
  echo "（没找到构建产物，跳过产物扫描——只查了源码）"
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "如果这是**故意**要连的地址（比如新的更新源），把它加进本脚本的白名单，"
  echo "并在那一行写清楚它凭什么进安装包。"
  exit 1
fi

echo "干净：源码与产物里没有任何私有服务器地址（域名或裸 IP）"

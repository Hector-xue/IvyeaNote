#!/usr/bin/env bash
# Ivyea Note 同步协议一致性测试（对应 shared/protocol.md 场景 C1~C5、C7）
# 用法：BASE=http://127.0.0.1:8080 ./conformance.sh
set -euo pipefail
BASE="${BASE:-http://127.0.0.1:8080}"
API="$BASE/api/v1"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  ✓ $1"; }
bad(){ FAIL=$((FAIL+1)); echo "  ✗ $1"; }
check(){ if [[ "$2" == "$3" ]]; then ok "$1 ($2)"; else bad "$1 (期望 $3，实际 $2)"; fi; }

TS=$(date +%s)
EMAIL="conf-$TS@ivyea.test"
PW="password-123456"
DA="deviceA-$TS"; DB="deviceB-$TS"

echo "== 准备：注册/登录/建库 =="
REG=$(curl -sf -X POST "$API/auth/register" -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}")
UID1=$(jq -r .user_id <<<"$REG")
TOK_A=$(jq -r .access_token <<<"$(curl -sf -X POST "$API/auth/login" -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}")")
VID=$(jq -r .id <<<"$(curl -sf -X POST "$API/vaults" -H "Authorization: Bearer $TOK_A" -d '{"name":"conf-vault"}')")
echo "  user=$UID1 vault=$VID"

push(){ # push <device> <json-changes>
  curl -sf -X POST "$API/sync/push" \
    -H "Authorization: Bearer $TOK_A" -H "X-Device-Id: $1" \
    -d "{\"vault_id\":$VID,\"changes\":$2}"
}
pull(){ # pull <cursor>
  curl -sf "$API/sync/changes?vault_id=$VID&cursor=$1&limit=100" -H "Authorization: Bearer $TOK_A"
}
put_blob(){ # put_blob <content> → sha256
  local h; h=$(printf '%s' "$1" | sha256sum | cut -d' ' -f1)
  printf '%s' "$1" | curl -sf -X PUT --data-binary @- "$API/blobs/$h" -H "Authorization: Bearer $TOK_A" >/dev/null
  echo "$h"
}

echo "== C1 双端顺序同步 =="
HA=$(put_blob "hello from A")
R=$(push "$DA" "[{\"client_change_id\":\"c1-a-$TS\",\"path\":\"a.md\",\"op\":\"upsert\",\"blob_hash\":\"$HA\",\"base_version\":0}]")
V1=$(jq -r '.results[0].version' <<<"$R"); check "A 建 a.md accepted" "$(jq -r '.results[0].status' <<<"$R")" "accepted"
CH=$(pull 0); check "B pull 收到 a.md" "$(jq -r '[.changes[]|select(.path=="a.md")]|length' <<<"$CH")" "1"
HB=$(put_blob "B edits a.md")
R=$(push "$DB" "[{\"client_change_id\":\"c1-b-$TS\",\"path\":\"a.md\",\"op\":\"upsert\",\"blob_hash\":\"$HB\",\"base_version\":$V1}]")
check "B 改 a.md accepted" "$(jq -r '.results[0].status' <<<"$R")" "accepted"
CH=$(pull 0); check "A pull 收到 B 的修改" "$(jq -r '[.changes[]|select(.device_id=="'"$DB"'")]|length' <<<"$CH")" "1"

echo "== C2 并发编辑冲突 =="
H1=$(put_blob "line-A"); H2=$(put_blob "line-B"); H3=$(put_blob "line-A+B merged")
RA=$(push "$DA" "[{\"client_change_id\":\"c2-a-$TS\",\"path\":\"n.md\",\"op\":\"upsert\",\"blob_hash\":\"$H1\",\"base_version\":0}]")
VA=$(jq -r '.results[0].version' <<<"$RA")
RB=$(push "$DB" "[{\"client_change_id\":\"c2-b1-$TS\",\"path\":\"n.md\",\"op\":\"upsert\",\"blob_hash\":\"$H2\",\"base_version\":$VA}]")
VB=$(jq -r '.results[0].version' <<<"$RB")
RC=$(push "$DA" "[{\"client_change_id\":\"c2-a2-$TS\",\"path\":\"n.md\",\"op\":\"upsert\",\"blob_hash\":\"$H3\",\"base_version\":$VA}]")
check "落后提交返回 conflict" "$(jq -r '.results[0].status' <<<"$RC")" "conflict"
check "conflict 带服务端版本" "$(jq -r '.results[0].server_version' <<<"$RC")" "$VB"
RD=$(push "$DA" "[{\"client_change_id\":\"c2-a3-$TS\",\"path\":\"n.md\",\"op\":\"upsert\",\"blob_hash\":\"$H3\",\"base_version\":$VB}]")
check "合并后以 server_version 重提 accepted" "$(jq -r '.results[0].status' <<<"$RD")" "accepted"

echo "== C3 删除 vs 修改（修改胜出/复活） =="
HX=$(put_blob "x-v1")
RX=$(push "$DA" "[{\"client_change_id\":\"c3-x-$TS\",\"path\":\"x.md\",\"op\":\"upsert\",\"blob_hash\":\"$HX\",\"base_version\":0}]")
VX=$(jq -r '.results[0].version' <<<"$RX")
RD1=$(push "$DB" "[{\"client_change_id\":\"c3-del-$TS\",\"path\":\"x.md\",\"op\":\"delete\",\"base_version\":$VX}]")
check "B 删 x.md accepted(v$((VX+1)))" "$(jq -r '.results[0].status' <<<"$RD1")" "accepted"
HX2=$(put_blob "x-modified-by-A")
RD2=$(push "$DA" "[{\"client_change_id\":\"c3-mod-$TS\",\"path\":\"x.md\",\"op\":\"upsert\",\"blob_hash\":\"$HX2\",\"base_version\":$VX}]")
check "A 基于 v$VX 修改 → conflict" "$(jq -r '.results[0].status' <<<"$RD2")" "conflict"
VS=$(jq -r '.results[0].server_version' <<<"$RD2")
check "冲突携带服务端版本 v$((VX+1))" "$VS" "$((VX+1))"
RD3=$(push "$DA" "[{\"client_change_id\":\"c3-resur-$TS\",\"path\":\"x.md\",\"op\":\"upsert\",\"blob_hash\":\"$HX2\",\"base_version\":$VS}]")
check "A 以服务端版本复活修改 accepted" "$(jq -r '.results[0].status' <<<"$RD3")" "accepted"

echo "== C4 幂等重试 =="
HY=$(put_blob "y-content")
RY1=$(push "$DB" "[{\"client_change_id\":\"c4-y-$TS\",\"path\":\"y.md\",\"op\":\"upsert\",\"blob_hash\":\"$HY\",\"base_version\":0}]")
RY2=$(push "$DB" "[{\"client_change_id\":\"c4-y-$TS\",\"path\":\"y.md\",\"op\":\"upsert\",\"blob_hash\":\"$HY\",\"base_version\":0}]")
check "首次 accepted" "$(jq -r '.results[0].status' <<<"$RY1")" "accepted"
check "重发仍 accepted(幂等)" "$(jq -r '.results[0].status' <<<"$RY2")" "accepted"
check "两次返回同一版本号" "$(jq -r '.results[0].version' <<<"$RY2")" "$(jq -r '.results[0].version' <<<"$RY1")"
CNT=$(curl -sf "$API/sync/changes?vault_id=$VID&cursor=0&limit=1000" -H "Authorization: Bearer $TOK_A" | jq '[.changes[]|select(.path=="y.md")]|length')
check "changes 流中 y.md 仅一条" "$CNT" "1"

echo "== C5 离线补账 + 游标分页 =="
N0=$(pull 0 | jq -r .next_cursor)   # 记录「离线前」游标
echo "  离线前 cursor=$N0"
for i in 1 2 3; do
  Hi=$(put_blob "offline-$i")
  push "$DA" "[{\"client_change_id\":\"c5-o$i-$TS\",\"path\":\"off-$i.md\",\"op\":\"upsert\",\"blob_hash\":\"$Hi\",\"base_version\":0}]" >/dev/null
done
CH2=$(pull "$N0")                    # 上线后从旧游标追平
GOT=$(jq -r '[.changes[].path]|join(",")' <<<"$CH2")
check "从旧游标追到全部离线增量(off-1~3)" "${GOT}" "off-1.md,off-2.md,off-3.md"
N1=$(jq -r .next_cursor <<<"$CH2")
check "再次拉取无重复(收敛)" "$(pull "$N1" | jq -r '[.changes[]]|length')" "0"

echo "== C7 删除传播 =="
RDY=$(push "$DA" "[{\"client_change_id\":\"c7-del-$TS\",\"path\":\"y.md\",\"op\":\"delete\",\"base_version\":$(jq -r '.results[0].version' <<<"$RY1")}]")
check "删 y.md accepted" "$(jq -r '.results[0].status' <<<"$RDY")" "accepted"
LAST=$(pull 0)
check "pull 流末尾含 y.md delete" "$(jq -r '[.changes[]|select(.path=="y.md" and .op=="delete")]|length' <<<"$LAST")" "1"

echo
echo "===== 结果：PASS=$PASS FAIL=$FAIL ====="
[[ $FAIL -eq 0 ]]

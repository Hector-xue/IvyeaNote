# Ivyea Note 同步协议 v1

> 状态：已实现（服务端参考实现：server/）｜ 本文档是桌面端/移动端 SyncClient 的实现契约。
> 所有端必须通过 `shared/conformance.md` 中的一致性场景才算合规。

## 1. 基本约定

- Base URL：`https://<host>/api/v1`；本协议所有示例省略前缀。
- 编码：UTF-8 JSON；时间戳一律 RFC3339 UTC；路径分隔符 `/`，禁止 `..`、绝对路径、反斜杠。
- 认证：`Authorization: Bearer <access_token>`（15 分钟有效）；过期返回 401 `{code:"token_expired"}`，客户端用 refresh token 换新（refresh 轮换，旧的立即作废）。
- 幂等键：push 的每条变更带 `client_change_id`（客户端生成的 UUID）。同一 `(device_id, client_change_id)` 重复提交返回首次结果，不产生第二条记录。

## 2. 数据模型（客户端视角）

- **Vault**：一个同步命名空间，对应本地一个文件夹。文件以相对路径标识（如 `日记/2026-08-24.md`）。
- **Change**：一次变更 = `{path, op, blob_hash}`。`op ∈ {upsert, delete}`；upsert 必须先上传 blob 再引用其 sha256。
- **Version**：每个 path 的单调递增版本号，由服务端分配。客户端为每个 path 记住「最后一次确认的 version」（base_version）。

## 3. API

### 3.1 认证
| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | /auth/register | {email,password} | {user_id} |
| POST | /auth/login | {email,password} | {access_token, refresh_token, user_id} |
| POST | /auth/refresh | {refresh_token} | {access_token, refresh_token(新的)} |

### 3.2 Vault
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /vaults | `{vaults:[{id,name,created_at}], deleted:[id…]}`；`deleted` 是已软删除的库 id（v0.11.25 起），客户端据此"放手"而不是当孤儿收养 |
| POST | /vaults | {name} → {id,name} |
| DELETE | /vaults/{id} | 软删除（v0.11.25）：列表不再有它、同步一律 403、内容原样留着 |
| PATCH | /vaults/{id} | {name} 改名（v0.11.25，库名跟着文件夹名走） |

### 3.3 同步
**PUSH** `POST /sync/push`
```json
{
  "vault_id": 1,
  "changes": [
    {"client_change_id":"u1","path":"a.md","op":"upsert","blob_hash":"<sha256>","base_version":0},
    {"client_change_id":"d1","path":"b.md","op":"delete","base_version":3}
  ]
}
```
响应（逐条结果，顺序与请求一致）：
```json
{"results":[
  {"client_change_id":"u1","status":"accepted","version":7},
  {"client_change_id":"d1","status":"conflict","server_version":4,"server_blob_hash":"..."}
]}
```
- `accepted`：写入成功，`version` 为该 path 新版本号。
- `conflict`：base_version 落后于服务端当前版本。客户端应 GET /blobs/{server_blob_hash} 取服务端内容做合并，合并后以 base_version=server_version 重新 push。
- 校验失败（hash 不存在/路径非法）→ 该条 `rejected{reason}`，不影响同批其他条目。

**PULL** `GET /sync/changes?vault_id=1&cursor=0&limit=500`
```json
{"changes":[
  {"seq":5,"path":"a.md","op":"upsert","blob_hash":"...","version":7,"device_id":"dA"},
  {"seq":6,"path":"b.md","op":"delete","version":4,"device_id":"dB"}
],"next_cursor":6}
```
- 客户端循环拉取直到 next_cursor 不再前进；每条 change 应用到本地后更新该 path 的本地 version。
- **应用规则**：跳过自己 device_id 的记录（自己的写已在本地）；upsert 且本地无此内容则下载 blob 写盘；delete 则删除本地文件。

### 3.3b 文件历史（v0.11.24，只读）
changes 只追加、blob 不删（§5）意味着每一版都在；这两条只是把它们列出来。**恢复不需要新接口**：客户端把旧版 blob 写回本地，下一轮 push 就是普通 upsert（base_version = 当前版本）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /sync/history?vault_id=1&path=a.md&limit=50 | 该路径历史版本，新的在前：`{versions:[{version,op,blob_hash?,size,device_id,created_at}]}` |
| GET | /sync/deleted?vault_id=1 | 当前已删除的路径（最近删的在前），`blob_hash` 指向删除前最后一版：`{files:[{path,version,blob_hash,size,deleted_at}]}` |

### 3.4 Blob
| 方法 | 路径 | 说明 |
|---|---|---|
| PUT | /blobs/{sha256} | body=原始字节；服务端校验哈希一致才入库 |
| GET | /blobs/{sha256} | 需属主在某个 vault 中引用过该 hash |

### 3.5 WebSocket 实时通知
- 连接 `GET /ws?token=<access_token>`（升级为 WSS）。
- 服务端在某 vault 有新变更时向该 vault 的其他在线设备推：
  `{"event":"dirty","vault_id":1}`
- 客户端收到后立即执行一轮 PULL。断线重连：指数退避 1s→2s→…→60s 封顶。

### 3.6 客户端义务（v0.11.25）
- **账本跟着位置走**：客户端记录同步账本对应的本地位置；位置变化时必须清零账本、从 cursor=0 按"最终状态"重新对账，**绝不能**把"本地没有"推理成 delete。
- **删除熔断**：一轮里本地消失的已知路径 ≥ 30% 且 ≥ 10（或全部、≥ 3）时不得推送 delete，须经用户确认。

## 4. 冲突解决规则（全端统一）

| 场景 | 规则 |
|---|---|
| 两端改同一 .md | 3-way 文本合并（共同祖先=base_version 对应内容）；成功自动提交，失败生成冲突副本 `<name>.conflict-<ts>.md` 并提示 |
| 一端删、一端改 | **修改胜出**：删除方 pull 到 upsert 后恢复文件（resurrect） |
| 移动/重命名 | 客户端建模为 delete(old)+upsert(new) 同批提交 |
| 二进制附件 | last-write-wins（版本高者胜） |
| 时钟 | 一律不信客户端时间戳，只认服务端 version 单调性 |

## 5. 删除与墓碑

- delete 是普通 change，永久保留于 changes 流（个人规模不做物理清理；未来加 TTL 时必须保留 ≥90 天）。
- 慢设备上线从 cursor=0 全量回放也能收敛到与服务端 heads 一致的状态。

## 6. 一致性测试场景（shared/conformance.md）

服务端与所有客户端实现必须通过以下场景（脚本化验证见 scripts/conformance.sh）：

1. **C1 双端顺序同步**：A 建 a.md → B pull 收到 → B 改 a.md → A pull 收到。
2. **C2 并发编辑冲突**：A、B 基于 v 各自修改 → 后到者收到 conflict → 合并后重新提交 → 两端最终内容一致。
3. **C3 删除 vs 修改**：B 删 x.md 同时 A 改 x.md → 最终 x.md 以 A 的修改存活（resurrect）。
4. **C4 幂等重试**：同 batch 重发两次 → 服务端只有一份变更，响应相同。
5. **C5 离线补账**：B 断网期间 A 改 3 个文件 → B 上线逐 cursor 追平，最终一致。
6. **C6 游标正确性**：B 用中间 cursor 分页拉取，不丢不重。
7. **C7 删除传播**：A 删 y.md → B pull 后 y.md 消失。
8. **C8 新设备冷启动**：C 从 cursor=0 全量回放 → 与 A/B 状态一致。

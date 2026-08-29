# 把 IvyeaNote 接进 IvyeaAgent（MCP）

> 状态：服务端已实现（v0.8.8 只读四工具，v0.8.9 加 `notes_write`）。
> 最后一步「在 agent 上配一条」需要你自己的账号来签发令牌，见 §3。
> 方案依据：`IvyeaNote-方案-v2.md` §6。

## 0. 这套东西解决什么

方案 §6.3 说得直白：**「Note 是 Agent 的输出终端」比「Note 是 Agent 的记忆」快十倍见效。**

- Agent 读你的笔记当语料（`notes_search` / `notes_read` / `notes_backlinks`）；
- Agent 把周报、店铺巡检、飞书对话产出直接写进 `Agent/2026-08-29-*.md`（`notes_write`），
  手机上打开 IvyeaNote 就能看——不需要 embedding、不需要新协议。

**融合走 MCP，不做代码耦合**：agent 侧零改代码，只加一条配置。

## 1. 为什么 MCP 挂在同步服务端

服务器上**没有 `.md` 目录**——笔记在服务端是内容寻址的 blob 加一张 `heads` 版本指针表。
而 agent 就跑在这台服务器上。

挂在同步服务端的结果：

- agent 读到的，和你手机、桌面看到的是**同一份真相**；
- agent 写进去的，走的是**和客户端完全相同的那条 push 路径**（同一套冲突判定、
  幂等去重、版本分配），因此会顺着既有同步链路自然收敛到所有端，不需要任何新协议；
- 写完立刻 `BroadcastDirty`，已连着 WebSocket 的端会马上拉。

客户端**一行都不用改**：它拉变更时只跳过自己设备的那些（`sync.ts:171`），
来自 `device_id=mcp` 的变更走的是和别的设备完全一样的路。

## 2. 服务端提供了什么

`POST https://<你的 note 服务器>/mcp`，JSON-RPC 2.0，工具五个：

| 工具 | 干什么 |
|---|---|
| `notes_list` | 列出全部笔记路径，可用 `prefix` 只看某目录 |
| `notes_read` | 读一篇的完整 Markdown |
| `notes_search` | 全文搜索，返回命中路径与命中行（含行号） |
| `notes_backlinks` | 查一篇的入链与出链（`[[双链]]`） |
| `notes_write` | 写入笔记，`mode` = `create`（默认，绝不覆盖）/ `append` / `overwrite` |

所有工具都接受可选的 `vault_id`；不传就用该账号的第一个库（多数人只有一个）。

### 写入的几条硬约束

- 路径必须合法（拒绝 `..`、绝对路径、反斜杠、空段）且以 `.md` 结尾；
- 单篇上限 2MB；
- **默认 `mode=create`，已存在就报错而不是覆盖**——一个跑飞的定时任务不该洗掉你的笔记；
- 就算真用了 `overwrite`，旧内容也还在：blob 是内容寻址的、变更流保留了历史版本，
  可以从 `GET /api/v1/sync/changes` 里翻回来。

## 3. 接入步骤

### 3.1 签发一张长期令牌

MCP 客户端没有刷新逻辑，所以**不能用普通的 access token**（它 15 分钟就过期，
结果会是「今天配好能用、明天悄悄不能用」）。用专门的长期令牌：

```bash
# 先用你的 note 账号登录拿一次性的 access token
AT=$(curl -s -X POST https://<你的服务器>/api/v1/auth/login \
      -H 'Content-Type: application/json' \
      -d '{"email":"你的邮箱","password":"你的密码"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["access_token"])')

# 签发 MCP 长期令牌（明文只显示这一次）
curl -s -X POST https://<你的服务器>/api/v1/mcp/tokens \
     -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' \
     -d '{"name":"ivyea-agent"}'
```

返回里的 `token`（形如 `ivnote_mcp_…`）**只显示这一次**，立刻保存。丢了就再签一张。

随时可以查看和撤销：

```bash
curl -s https://<你的服务器>/api/v1/mcp/tokens -H "Authorization: Bearer $AT"
curl -s -X DELETE https://<你的服务器>/api/v1/mcp/tokens/<id> -H "Authorization: Bearer $AT"
```

列表里只有前 8 位哈希和 `last_used_at`——**明文不落库**，服务端也拿不出来。

### 3.2 在 agent 上加一条

```bash
ivyea mcp add
```

向导里这样答：

| 问题 | 答 |
|---|---|
| 名称 | `note` |
| 传输方式 | `http` |
| 服务器 URL | `https://<你的服务器>/mcp` |
| 鉴权方式 | `header` |
| Header 名 | `Authorization` |
| Header 值 | `Bearer ivnote_mcp_…`（上一步那串） |
| 信任此服务器？ | 看下面 |

等价的手写配置（`~/.ivyea/mcp.json`）：

```json
{
  "mcpServers": {
    "note": {
      "transport": "http",
      "url": "https://<你的服务器>/mcp",
      "headers": { "Authorization": "Bearer ivnote_mcp_…" },
      "trusted": true
    }
  }
}
```

**关于 `trusted`**：信任 = 调用该服务器的工具免人工审批。
只读用得着（否则无人值守任务会卡在审批上），但它同时也会让 `notes_write` 免审批。
如果你不希望 agent 在无人看着的时候往笔记里写，就**别设 `trusted`**，
让写操作走审批；或者先只在有人盯着的会话里用。

### 3.3 验一下

```bash
ivyea mcp list                 # 应看到 note / http / header
ivyea mcp call note notes_list # 应列出你的笔记
```

## 4. 建议的用法

- **Agent 的产出统一落到 `Agent/` 目录**：`Agent/2026-08-29-周报.md`、
  `Agent/2026-08-29-店铺巡检.md`。好处是一眼分得清哪些是机器写的，
  哪些是你自己写的；不想要了整个目录删掉即可。
- **同一天多次追加用 `mode=append`**，不要 `overwrite`：定时任务重跑时不会丢内容。
- **让 agent 在产出里写 `[[双链]]`**：写完立刻会成为对应笔记的入链，
  知识网络自己就把机器产出吸收进去了（这条已实测）。

## 5. 已经验证过什么

服务端这半边是拿 **agent 自己的 `MCPClient`** 连本地实例实测过的，不是照规范推演：

- `initialize` / `tools/list` / `tools/call` 全通，`resources/list` 与 `prompts/list`
  回空表（回 `-32601` 会让 agent 启动时记两次错误）；
- 工具级失败走 `result.isError` 而不是 JSON-RPC error（后者会让 agent 以为「连接坏了」）；
- 鉴权边界：无令牌 / 错令牌 / **拿 access token 冒充** / 撤销后，全部 401；
- 跨账号隔离：用「有自己库的另一个账号去读别人的 `vault_id=1`」验的，
  返回「不存在或不属于当前账号」；
- 写入：`create` 拒绝覆盖、`append` 正确补换行、`overwrite` 生效、
  `../` 与非 `.md` 被拒；写完的笔记立刻能被 `notes_search` 搜到、
  成为目标笔记的入链，并且以 `device_id=mcp` 出现在同步变更流里、
  按 blob 能取回正文——也就是客户端按既有 pull 就能拿到。

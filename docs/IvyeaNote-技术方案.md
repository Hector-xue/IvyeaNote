# Ivyea Note 技术方案

> 版本：v1.0 ｜ 日期：2026-08-24 ｜ 状态：待评审
> 目标：做一个类 Obsidian 的笔记软件，桌面程序 + 手机 APP，后端部署在自己的服务器上，实现多端实时同步，数据完全自持。

---

## 0. 先说清楚一个前提（诚实建议）

如果痛点**只是**「多端同步」，有现成的低成本路线，先列出来供对照：

| 路线 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A. Syncthing | 电脑装 Syncthing，手机用 Möbius Sync(iOS)/Syncthing(Android)，同步 Obsidian vault 文件夹 | 零开发、点对点、免费 | iOS 支持差、无版本历史、配置门槛 |
| B. Self-hosted Remotely Save 插件 | Obsidian 插件 + 自建 S3/WebDAV | 半天搞定 | 依赖插件维护、冲突处理弱 |
| C. Joplin 自建 | 换成 Joplin + 自建同步后端 | 全开源免费 | 编辑器体验不如 Obsidian |

**本方案默认你要的是 D：自研完整产品**（可控、可定制、长期资产）。若只是想尽快解决同步问题，A/B 一天内可用，随时告诉我可以切换目标。

---

## 1. 产品定义

### 1.1 核心原则
1. **本地优先（Local-first）**：笔记是磁盘上普通的 `.md` 纯文本文件夹（Vault），不锁死在任何数据库里，随时可以用 Obsidian/VSCode 直接打开。
2. **离线完整可用**：断网时增删改查全部正常，联网后自动同步。
3. **服务端是「哑管道」**：只负责可靠存储与分发，不理解内容语义；V2 起支持端到端加密后连明文都看不到。
4. **数据可迁移**：一键导入 Obsidian Vault；导出即原始文件夹。

### 1.2 功能范围

**MVP（V1）必须**
- [x] Markdown 编辑（语法高亮、所见即所得可选）、双链 `[[]]`、标签、反链面板
- [x] Vault 文件树管理（新建/重命名/移动/删除/回收站）
- [x] 全文搜索（本地索引）
- [x] 图片/附件插入（本地引用 + 自动上传同步）
- [x] 多端同步：桌面(Windows/macOS/Linux) + 手机(iOS/Android)，增量、断点续传、冲突自动合并
- [x] 账号登录（先支持单用户「个人模式」，预留多用户）

**V2 规划**
- 端到端加密（E2EE，服务端零知识）
- 笔记历史版本浏览/回滚（服务端保留 90 天）
- 发布分享（只读链接）、插件系统、Graph View、模板、每日笔记

### 1.3 明确不做（V1）
- 实时多人协作编辑（CRDT/OT，复杂度数量级上升，与单人多端场景不匹配）
- 所见即所得的富文本块编辑器（Notion 式），V1 以 Markdown 为唯一事实格式

---

## 2. 技术选型

### 2.1 选型对比与结论

| 层 | 候选 | 结论 | 关键理由 |
|---|---|---|---|
| 桌面壳 | Electron / **Tauri 2** | **Tauri 2** | 包体 ~10MB vs ~150MB；内存占用低；Rust 侧可直接承载同步核心；Tauri 2 已支持移动端（保底方案） |
| 桌面 UI | React / Vue / Svelte | **React + TypeScript** | 生态最全，CodeMirror/ProseMirror 封装成熟 |
| 编辑器内核 | CodeMirror 6 / ProseMirror(Tiptap/Milkdown) / Monaco | **CodeMirror 6** | Obsidian 同款内核；Markdown 支持一流；性能好（万行文档流畅）；后续想要所见即所得再叠 Milkdown |
| 移动端 | Flutter / React Native / Tauri Mobile / 原生双端 | **Flutter** | 一套代码出 iOS+Android；文字渲染与滚动性能优于 RN；markdown 编辑器组件（super_editor/AppFlowy Editor）可用 |
| 同步客户端逻辑 | 各端各写 / Rust 共享库 | **MVP 各端薄实现 + shared 协议测试集**，V2 下沉 Rust 库（flutter_rust_bridge / Tauri 直链） | 同步客户端很薄（REST+SQLite），重复实现的成本 < 跨语言 FFI 的调试成本；用同一套协议一致性测试保证两端行为一致 |
| 服务端语言 | Go / Node(NestJS) / Python(FastAPI) / Rust(Axum) | **Go** | 单二进制部署最省心；并发模型适合长连接推送；交叉编译方便 |
| 数据库 | PostgreSQL / SQLite / MongoDB | **PostgreSQL 15+** | 事务、JSONB、全文检索备用；运维资料最多 |
| Blob 存储 | 本地磁盘 / MinIO / S3 | **本地磁盘（按 sha256 内容寻址）**，接口抽象好随时换 MinIO | 个人规模（<100GB）没必要上对象存储 |
| 反向代理/TLS | Nginx / Caddy / Traefik | **Caddy** | 自动申请续期 HTTPS 证书，零配置 |
| 认证 | 自研 JWT / 第三方(Authelia 等) | **自研 JWT（access 15min + refresh 30d 轮换）**，argon2id 存密码 | 单用户场景自研足够且可控 |

### 2.2 推荐组合一句话
**Tauri 2 + React + CodeMirror 6（桌面）｜ Flutter（移动）｜ Go + PostgreSQL + 本地 Blob + Caddy（服务端）｜ REST + WebSocket 同步协议**

---

## 3. 总体架构

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│   桌面端 (Tauri) │      │  移动端(Flutter) │      │  其他端(未来CLI) │
│  React+CM6 UI   │      │  super_editor   │      │                 │
│  ┌───────────┐  │      │  ┌───────────┐  │      │                 │
│  │SyncClient │  │      │  │SyncClient │  │      │                 │
│  └─────┬─────┘  │      │  └─────┬─────┘  │      │                 │
│   ┌────▼────┐   │      │   ┌────▼────┐   │      │                 │
│   │ SQLite  │   │      │   │ SQLite  │   │      │   （同协议接入）  │
│   │ 本地索引 │   │      │   │ 本地索引 │   │      │                 │
│   └─────────┘   │      │   └─────────┘   │      │                 │
└────────┬────────┘      └────────┬────────┘      └────────┬────────┘
         │  HTTPS(REST) + WSS     │                        │
         └───────────────┬────────┴────────────────────────┘
                         ▼
              ┌──────────────────────┐
              │   Caddy (443/TLS)    │
              └──────────┬───────────┘
                         ▼
              ┌──────────────────────┐     ┌──────────────┐
              │   Go 同步服务         │◄───►│ PostgreSQL   │
              │  auth / sync / blob  │     └──────────────┘
              │  ws-push / 版本历史   │     ┌──────────────┐
              └──────────┬───────────┘◄───►│ Blob 存储     │
                         │                 │ (磁盘/sha256) │
                         ▼            └──────────────┘
              ┌──────────────────────┐
              │ restic 定时备份 → S3/B2│
              └──────────────────────┘
```

要点：
- **所有读写都发生在本地**：UI 只操作本地文件 + SQLite 索引；SyncClient 是独立后台模块，负责把本地变更推上去、把远端变更拉下来。
- 服务端无状态化（JWT），水平扩展预留；个人部署单实例足够。

---

## 4. 数据模型

### 4.1 客户端（每端一份 SQLite）

```sql
-- 文件索引表：vault 内每个文件的本地状态
CREATE TABLE files (
  path        TEXT PRIMARY KEY,      -- vault 相对路径，如 "日记/2026-08-24.md"
  content_hash TEXT,                 -- sha256，空=未变
  size        INTEGER,
  mtime       INTEGER,               -- 本地修改时间
  is_dir      INTEGER DEFAULT 0,
  deleted     INTEGER DEFAULT 0      -- 本地删除标记（进回收站）
);

-- 同步游标：记录已拉取到服务端的哪个位置
CREATE TABLE sync_state (
  vault_id TEXT PRIMARY KEY,
  cursor   INTEGER,                  -- 服务端全局递增序号
  pushed_at INTEGER
);
```

### 4.2 服务端（PostgreSQL）

```sql
CREATE TABLE users (
  id           BIGSERIAL PRIMARY KEY,
  email        TEXT UNIQUE,
  password_hash TEXT,                -- argon2id
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE vaults (
  id      BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id),
  name    TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 变更日志：同步的核心表，全局递增 seq 作为拉取游标
CREATE TABLE changes (
  id            BIGSERIAL PRIMARY KEY,      -- 即 seq/cursor
  vault_id      BIGINT REFERENCES vaults(id),
  path          TEXT,
  op            TEXT CHECK (op IN ('upsert','delete')),
  blob_hash     TEXT,                       -- upsert 时指向 blobs
  version       BIGINT,                     -- 该路径的版本号，单调递增
  base_version  BIGINT,                     -- 客户端提交时所基于的版本（冲突检测用）
  device_id     TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON changes (vault_id, id);

-- 每个路径的当前状态（快速判断冲突 & 全量对账）
CREATE TABLE heads (
  vault_id BIGINT,
  path     TEXT,
  version  BIGINT,
  blob_hash TEXT,
  deleted  BOOLEAN DEFAULT false,
  PRIMARY KEY (vault_id, path)
);

-- 内容寻址的 blob 去重存储
CREATE TABLE blobs (
  hash      TEXT PRIMARY KEY,     -- sha256
  size      INTEGER,
  ref_count INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 历史版本（V2 启用）：changes 表本身天然就是历史，加 TTL 清理策略即可
```

Blob 实际文件落盘路径：`/var/lib/ivyea-note/blobs/ab/cdef1234...`（哈希前两位分目录，避免单目录文件过多）。

---

## 5. 同步协议（核心设计）

### 5.1 基本流程

```
客户端启动/联网/前台化
   │
   ├─ 1. PUSH：把本地未推送的变更批量上报
   │     POST /api/v1/sync/push
   │     [{path, op, base_version, blob_hash?, content?}]
   │     ← 每条返回 accepted / conflict{server_version}
   │
   ├─ 2. PULL：拉取游标之后的增量
   │     GET /api/v1/sync/changes?vault=..&cursor=N&limit=500
   │     ← {changes:[...], next_cursor}
   │
   └─ 3. 循环直到 next_cursor 不变 → 进入空闲
         WebSocket 收到 "dirty" 通知 → 立刻回到第 2 步（近实时）
```

- **幂等**：push 带 `client_change_id`（uuid），服务端去重，重试安全。
- **断点续传**：pull 按 cursor 分页；push 失败整批重发（靠幂等去重）。
- **附件**：大文件走 `PUT /api/v1/blobs/{sha256}` 预上传（分片，≥8MB 才分片），push 时只带 hash 引用。

### 5.2 冲突检测与解决

判定规则：push 时 `base_version != heads[path].version` → 冲突。

| 场景 | 策略 |
|---|---|
| 两端改了同一个 .md | 服务端返回双方内容+共同祖先版本（changes 表里有祖先链）→ 客户端做 **3-way 文本合并**（diff-match-patch）；合并成功→自动写回再 push；失败→生成冲突副本 `笔记.conflict-20260824-0951.md` 并通知用户手动处理（与 Obsidian Sync 行为一致） |
| 一端删、一端改 | **修改胜出**（防误删丢稿），删除方收到 resurrect |
| 重命名/移动 | 建模为 delete(old)+upsert(new) 原子批次；两端移到不同位置→以服务端先到的为准，另一端生成副本提示 |
| 附件/图片 | 无合并概念，last-write-wins（按版本号高者） |
| 时钟无关性 | 全程只用服务端版本号比较，**不信任客户端时间戳**（避免手机时钟漂移导致丢数据） |

### 5.3 删除与墓碑

- 删除 = 一条 `op=delete` 的 change，保留 ≥90 天后才物理清理，慢设备（几个月没开 App 的手机）上线也能正确收敛删除。
- 客户端本地删除先进应用内回收站（30 天可恢复），再参与同步。

### 5.4 性能与配额

- 单文件上限 50MB，单 vault 建议 ≤2 万文件（实测后调整）。
- pull 增量打包 gzip；图片等二进制不做 diff。
- 用户配额默认 20GB（自己服务器自己定），超限拒绝写入并全端提醒。

---

## 6. API 设计（REST + WS）

统一前缀 `/api/v1`，JSON，错误码 `{code, message}`。

### 认证
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /auth/register | 注册（个人模式可关闭） |
| POST | /auth/login | 登录 → {access_token(15m), refresh_token(30d)} |
| POST | /auth/refresh | 刷新 access_token（refresh 轮换，旧 refresh 作废） |
| POST | /devices | 注册设备 → device_id（用于推送定向与审计） |

### 同步
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /vaults | 我的 vault 列表 |
| POST | /vaults | 新建 vault |
| GET | /sync/changes?vault=&cursor=&limit= | 增量拉取 |
| POST | /sync/push | 批量推送变更（含幂等键） |
| GET | /sync/full-check?vault= | 全量对账：返回 heads 摘要哈希，客户端比对发现漏同步 |
| PUT | /blobs/{sha256} | 上传附件（支持分片） |
| GET | /blobs/{sha256} | 下载附件（校验属主权限） |

### 实时通知
| 路径 | 说明 |
|---|---|
| WSS /ws | 鉴权后常驻；收到其他设备变更时推 `{"event":"dirty","vault":..}`，客户端触发 pull。断线指数退避重连（1s→2s→…→60s 封顶） |

---

## 7. 安全设计

1. **传输**：仅 HTTPS/WSS（Caddy 自动证书），HSTS 开启。
2. **认证**：argon2id 密码哈希；JWT 短时效 + refresh 轮换；设备级吊销。
3. **授权**：所有资源校验 `user_id` 归属；blob 下载校验该用户 vault 中确实引用了此 hash（防止哈希枚举下载他人内容）。
4. **防滥用**：登录限速（5 次/分钟/IP）、push 限速、请求体大小限制。
5. **备份**：每晚 `pg_dump` + blob 目录 restic 增量备份到对象存储（S3/B2），保留 30 天；**每季度演练一次恢复**。
6. **V2 E2EE**：客户端用口令经 Argon2id 派生密钥包一层 vault key，服务端只见密文；代价是服务端无法做全文检索（客户端本地索引弥补）。

---

## 8. 部署方案（你的服务器）

### 8.1 要求
- 服务器：≥1核1G 可跑，推荐 2核4G；Linux x86_64
- 域名一个（如 `note.example.com`），A 记录指到服务器；防火墙只开 22/80/443

### 8.2 Docker Compose 编排（deploy/ 下落地）

```yaml
services:
  caddy:      # 443 自动 HTTPS，反代 app
  app:        # Go 同步服务，单二进制
  postgres:   # 15-alpine，数据卷持久化
  backup:     # cron 容器：pg_dump + restic → S3
```

### 8.3 上线步骤（脚本化到 deploy/install.sh）
1. 服务器装 Docker + Compose
2. 克隆仓库，`cp .env.example .env` 填域名/密码/S3 备份密钥
3. `docker compose up -d`，DNS 生效后 Caddy 自动签证书
4. 注册首个账号（个人模式锁定注册）
5. 验证：桌面端登录 → 造一条笔记 → 手机端 10s 内出现

### 8.4 运维
- 日志：app 输出 JSON 到 stdout，`docker compose logs` 查看；可选接 Loki
- 监控：内置 `/healthz`、`/metrics`(Prometheus 格式)；UptimeRobot 免费拨测
- 升级：`git pull && docker compose build app && docker compose up -d app`（数据库迁移用 golang-migrate 自动执行，先备份再升级）

---

## 9. 开发路线图

按 1 人业余时间（每周 ~15h）估算：

| 里程碑 | 周期 | 交付物 | 验收标准 |
|---|---|---|---|
| **M0 奠基** | 1 周 | 仓库初始化、CI(GitHub Actions)、协议文档+一致性测试用例框架 | CI 绿灯 |
| **M1 服务端+协议验证** | 3 周 | auth/vault/sync/blob API、WS 推送、docker compose 部署脚本 | 用两个 curl 脚本模拟双端，冲突/离线/乱序用例全部收敛一致 |
| **M2 桌面端 MVP** | 4 周 | Tauri 应用：文件树、CM6 编辑器、双链/标签、搜索、后台同步 | 与官方 Obsidian 同时打开同一 vault 目录互不破坏；断网编辑→联网自动同步 |
| **M3 移动端 MVP** | 4 周 | Flutter App：浏览/编辑/搜索/拍照插图/同步 | iOS+Android 真机通过；后台回前台 5s 内完成增量同步 |
| **M4 打磨发布** | 2 周 | 冲突 UI、回收站、设置页、自动更新、安装文档 | 自己全设备日常使用一周无数据丢失 |
| **V2** | 按需 | E2EE、历史版本、分享链接、插件 | — |

**风险与对策**
| 风险 | 对策 |
|---|---|
| 同步 bug 丢数据（最大风险） | 本地文件永远最后才动：先写临时文件再原子 rename；每次同步前快照；协议一致性测试覆盖乱序/重复/离线用例 |
| iOS 后台限制导致同步不及时 | 回前台/打开 App 时强制 pull；WS 仅前台保活；接受「iOS 推送延迟」为平台约束 |
| Flutter 编辑器体验不及 CM6 | V1 移动端以「查看+轻编辑」定位，重度编辑回桌面；后续评估 super_editor 深度定制 |
| 个人服务器单点故障 | restic 异地备份 + 客户端本地永远有全量数据（local-first 天然容灾） |

---

## 10. 下一步行动清单

1. 确认本方案（尤其第 0 节是否真的要自研、第 2 节选型有无偏好）
2. 准备：域名、服务器 SSH、GitHub 仓库
3. 我可以直接开工：先落 M0+M1（服务端骨架 + compose 部署 + 协议测试），你说一声就开始

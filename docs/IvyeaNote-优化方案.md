> **【已归档】本文件自 2026-08-29 起被 `IvyeaNote-方案-v2.md` 取代，不再更新。保留供历史追溯。**

# IvyeaNote 完整优化方案

> 版本：v1.1 ｜ 2026-08-25 ｜ 状态：阶段 0 已实施（v0.3.3），阶段 1 待启动
> 依据：① 对当前代码（v0.3.2，commit 34e6af7）的逐文件诊断；②《GPT的ivyeanote优化方案》目标架构；③ 既有《IvyeaNote-技术方案.md》。
> 目标：把 IvyeaNote 从"能跑的 demo"做成**完整产品**——Local-first + 多端同步 + Markdown 兼容 + AI 原生的个人知识库，并成为 IvyeaAgent 体系的记忆层。

---

## 第一部分：现状诊断（为什么 Windows exe 是个"垃圾"）

### 1.1 致命缺陷：Windows 上"除文本输入外按钮全点不动"的根因

**全部经当前代码复核，行号为 v0.3.2 实际代码：**

| # | 根因 | 位置 | 机制 |
|---|------|------|------|
| R1 | `window.prompt` 在 WebView2 中不被支持 | `desktop/src/App.tsx:333`（新建笔记）、`:463`（新建笔记库） | WebView2（Windows Tauri 内核）调用 `prompt()` 静默返回 `null`，不弹任何框 → 代码 `if (!name) return` → **点了按钮毫无反应** |
| R2 | 免登录本地模式被云端 client 门控 | `App.tsx:270-273`（文件列表加载）、`:118/:143/:161`（同步/上传/下载） | v0.3.1 引入"免登录本地模式"，但 `refreshFiles` 的触发 useEffect 和三个同步函数开头都是 `if (!client ...) return`；本地模式 `client=null` → **侧栏文件列表永远为空、同步类按钮全是静默 no-op** |
| R3 | 违反 React Rules of Hooks | `App.tsx:510` 条件 return（登录页）之后，`:524` 才调用 `useIsMobile()`（内含 useState+useEffect） | 打开/关闭登录页时 hooks 数量不一致 → React 抛 "Rendered more/fewer hooks" → **点开登录直接崩** |
| R4 | 全项目无 ErrorBoundary | `desktop/src/main.tsx` 直接 `render(<App/>)` | 任何渲染异常（含 R3 触发的）→ **整页白屏，无任何提示** |
| R5 | 函数对象挂属性做防抖 | `App.tsx:317-318` `(onEdit as unknown as {t?:number}).t` | 脆弱、类型不安全，重构即坏 |

**为什么"文本能输入"**：CodeMirror 6 走原生 DOM 事件与自管状态，不依赖上面任何一条；而所有按钮要么撞 R1（prompt 死）、要么撞 R2（门控死）、要么触发 R3+R4（崩溃白屏）。三者叠加 = "整个就是个垃圾"的直接来源。

### 1.2 结构性差距（对照 GPT 方案目标架构）

| 目标（GPT 方案） | 现状 | 差距 |
|---|---|---|
| 数据归用户：纯 Markdown 目录（Notes/ + Attachments/ + .ivyea/） | 桌面默认存 OPFS（浏览器虚拟存储），不绑文件夹用户根本看不到自己的数据 | **大** |
| 本地 SQLite 索引（notes/tags/backlinks/fts5） | 无，纯文件 + localStorage 元数据 | **大** |
| 本地全文搜索（FTS5，10ms 级） | 无任何搜索 | **大** |
| Markdown + Block 级 CRDT 合并 | 文件级 3-way diff3 合并 + 冲突副本（已实测 17/17、服务端 19/19） | 中（现有方案可用，CRDT 是演进项） |
| 自建 Sync Server（Go + PostgreSQL + 对象存储） | ✅ 已有，Go 服务端已上线、协议完整、一致性测试通过 | 小（缺对象存储分列、版本历史） |
| 多端：桌面 + 手机 | 桌面 Tauri ✅；Android 走 Tauri Android（v0.3.0+，CI 出 APK）；iOS 无 | 中 |
| P2P / 局域网同步 | 无 | 远期 |
| E2EE 端加密 | 无（TLS 传输加密有） | 远期 |
| AI 原生：语义搜索/总结/自动标签/Agent 记忆层 | 无 | 远期（本机已有 ollama，条件具备） |
| 反链/图谱/标签/附件/回收站/版本历史 | 全无 | **大** |

**结论**：服务端与同步协议底座扎实（这是最难的 30%，已经完成且经过测试）；真正的断裂点在**桌面客户端质量**（P0）和 **local-first 知识功能缺失**（P1/P2）。

### 1.3 移动端技术路线决策（与 GPT 方案的唯一分歧）

GPT 方案推荐 Flutter。**本项目决定保留 Tauri（桌面 + Android 统一 React 代码库），不切 Flutter**。理由：

1. GPT 的 Flutter 建议基于"从零开始"前提；本项目 Tauri 多端已跑通（v0.3.0 起 CI 自动出 APK），React/TS 代码桌面+安卓共享约 90%。
2. 切 Flutter = UI、编辑器、同步引擎全部用 Dart 重写一遍，等于重做整个客户端，与"已有可用底座"的现实冲突。
3. Tauri 2 官方支持 Android（iOS 也在路线图上）；iOS 延后到具备 macOS 构建条件与 Apple 开发者账号再做。

代价：安卓端是 WebView 渲染，极致性能不如 Flutter 原生——对笔记类应用可接受。

---

## 第二部分：目标架构（终态）

```
                IvyeaNote 客户端（Tauri 2 + React + TS）
                Desktop(Win/mac/Linux) / Android / (iOS 远期)
                              │
                 ┌────────────┴────────────┐
                 │   Local-first 数据层     │
                 │  Markdown 文件（用户可见）│
                 │  + SQLite 索引(.ivyea/)  │
                 │    FTS5 / 标签 / 反链     │
                 └────────────┬────────────┘
                              │
                     Sync Engine（现有 3-way
                     合并 → 渐进增强至块级）
                 ┌────────────┼────────────┐
                 ↓            ↓            ↓
            云同步          P2P 局域网     手动导出
        (Go+PostgreSQL)   (远期)        (纯 Markdown)
                 │
            IvyeaAgent ←── 记忆层 API（语义检索/知识图谱）
```

三条不可动摇的原则（来自 GPT 方案，全部采纳）：

1. **数据归用户**：默认存储必须是用户文件系统里可见的 Markdown 目录，OPFS 只作为浏览器版兜底。
2. **搜索本地化**：一切检索（全文/标签/反链/语义）先查本地 SQLite，10ms 级返回，不走服务器。
3. **同步 ≠ 上传文件**：同步引擎是一等公民，冲突必须可见、可选、可回滚，绝不允许静默覆盖用户内容。

---

## 第三部分：分阶段实施计划

### 阶段 0（P0 急救）：修好 Windows exe —— v0.3.3

**目标：每一个按钮在 Windows/macOS/Linux/Android 上点了都有反应；崩溃可见、可恢复。**

| 任务 | 具体改动 | 文件 |
|---|---|---|
| 0.1 消灭 `window.prompt` | 新建应用内对话框组件（模态 + 输入 + 确认 + Toast），替换 `onCreateNote`、`createVault` 中的 prompt；`onDeleteFile` 的 confirm 一并替换（保证安卓一致） | 新增 `desktop/src/ui/Dialog.tsx`；改 `App.tsx:330-369, 458-473` |
| 0.2 本地模式解门控 | 文件列表加载改为只依赖 `vault`（去掉 `!client` 条件）；同步/上传/下载按钮在无账号时改为显式"登录后可用"态（禁用 + 提示），不再静默 no-op | `App.tsx:270-273, 117-183` + 侧栏按钮组件 |
| 0.3 修 Hooks 违例 | `useIsMobile()` 及全部 hooks 移到组件顶部、任何条件 return 之前；登录页改为条件渲染而非 early return | `App.tsx:507-524` |
| 0.4 加 ErrorBoundary | 崩溃时显示友好错误页（含"复制错误信息/重载"），不再白屏 | `main.tsx` + 新增 `ui/ErrorBoundary.tsx` |
| 0.5 修防抖 | 函数挂属性改 `useRef<number>` | `App.tsx:312-328` |
| 0.6 防回归 | 引入 `eslint-plugin-react-hooks` 进 CI（hooks 规则违例直接挡住提交）；补 vitest 用例：本地模式文件列表加载、新建笔记、无 client 时同步按钮状态 | `package.json`、CI、`src/__tests__/` |

**验收标准（全部可测）：**
- Windows 安装包：新建笔记/新建库/删除/切换主题/打开登录页，每个按钮点击均有可见响应；
- 免登录启动：侧栏 3 秒内列出本地库全部 .md 文件，可打开、编辑、新建、删除；
- 故意制造渲染错误 → 出错误页而非白屏；
- `tsc -b`、vitest、eslint（含 hooks 规则）全绿；CI 三平台产物正常挂上 Release。

> **实施记录（2026-08-25，v0.3.3）**：0.1~0.5 全部落地；0.6 按项目实际工具链调整——项目用 **oxlint** 而非 eslint，其 `react-hooks/rules-of-hooks` 已是 error 级（修复前实测可抓到 R3 违例），故门禁直接用 `oxlint src && tsc -b && vitest run`，新增 `.github/workflows/ci.yml` 并在 release.yml 打包前插入同一套门禁。新增 8 个回归测试（App.test.tsx 覆盖 R1/R2/R3 按钮行为，ErrorBoundary.test.tsx 覆盖 R4），全量 34/34 通过。Windows 真机验收由用户下载 v0.3.3 Release 后按上述清单点检。

### 阶段 1：Local-first 落地 —— v0.4

> **实施记录（2026-08-26，v0.5.0 第二批·UI 对标）**：用户以四组截图对比指出呈现层差距（Obsidian 是成稿、IvyeaNote 是源码），落地六项 UI 重做：
> - **U1 实时预览**：新增 `lib/livePreview.ts`（CodeMirror ViewPlugin 装饰）——标题/加粗/斜体/行内代码/引用在编辑态直接渲染，标记符光标靠近时显示源码（Obsidian live preview 行为）；任务 `- [ ]` 渲染为可点击复选框（点击切换源码，完成项划线）；隐藏行号。
> - **U3 文件树**：新增 `ui/FileTree.tsx`——多层递归树、文件夹优先排序、隐藏 .md 后缀、hover 浮现操作、折叠状态持久化（`ivnote.collapsed`）、新建文件夹（`.keep` 占位）。
> - **U4 状态栏**：新增 `lib/wordCount.ts`——中英混排词数/字符数（CJK 逐字、英文分词、代码块不计），底部状态栏显示路径+统计。
> - **U2 多标签页**：新增 `ui/TabsBar.tsx`——打开即开标签、切换/关闭、关闭当前自动回退相邻、持久化（`ivnote.tabs`/`ivnote.activeTab`）。
> - **U5 icon ribbon**：新增 `ui/Icons.tsx` 线性 SVG 图标集（stroke 1.6 wireframe 风），左侧 ribbon：文件/回收站/主题切换。
> - **U6 排版**：可读行宽 760px 居中、正文 15px/1.75 行高、系统无衬线字体栈。
>
> 门禁全绿：tsc OK、vitest 83/83（新增 livePreview 5 + FileTree 6 + wordCount 7 + TabsBar 5）、vite build OK。

> **实施记录（2026-08-26，v0.4.0 第一批）**：用户实测 v0.3.4「导入 Obsidian / 绑定文件夹报错、新建笔记繁琐」，对标 Obsidian 重做可用性。已落地五项：
> - **R1（根因修复）**：`capabilities/default.json` 缺 `dialog:default` 权限 → plugin-dialog 的 `open()` 被 Tauri 2 权限模型直接拒绝，导入/绑定必报错。补一行即修复。
> - **T2 首启引导**：新增 `WelcomeView.tsx` 三卡（打开本地文件夹 / 从 Obsidian 导入 / 新建空白库），免登录即用；`ivnote.welcomed` 标记只显示一次。
> - **T3 即时新建 + 标题跟随**：新建不再弹框要名字，直接建 `untitled.md`（重名自动序号）；新增 `lib/titleSync.ts`（extractH1/sanitizeTitle/titleToPath/uniqueName），编辑防抖落盘后 H1 与文件名不一致时自动重命名（同步层表达为新路径 upsert + 旧路径 delete）。
> - **T4 导入体验**：进度条（n/N）+ 单文件失败不中断 + 完成明细 toast；登录态下导入完自动 pushOnly。
> - **T5 回收站**：删除移入 `.trash/时间戳-文件名`，侧栏回收站入口支持恢复/彻底删除；主列表过滤 `.trash/`。
>
> 门禁全绿：oxlint 0 error、tsc OK、vitest 60/60（含 titleSync 10 例与即时新建/回收站新回归）、vite build OK。阶段 1 剩余任务（SQLite 索引/FTS5 搜索/版本历史）待后续批次。

**目标：数据真正归用户 + 本地搜索，达到"非常好用的 Markdown 笔记软件"（GPT 路线 V0.1）。**

| 任务 | 说明 |
|---|---|
| 1.1 默认真实文件夹 | 桌面首启引导选择/创建 `IvyeaNote/` 目录（`Notes/` + `Attachments/` + `.ivyea/`）；OPFS 降级为浏览器版兜底；提供"一键把 OPFS 数据导出到真实文件夹"迁移 |
| 1.2 SQLite 本地索引 | `tauri-plugin-sql`：表 `notes / tags / links / history / sync_ops`；文件系统 watcher 增量建索引；索引损坏可全量重建（文件是唯一事实源） |
| 1.3 全文搜索 | SQLite FTS5（含中文分词器 simple/trigram 方案）；`Ctrl+K` 搜索面板，文件级+行级命中预览，10ms 级 |
| 1.4 标签系统 | frontmatter `tags:` + 正文 `#tag` 双解析，标签面板、按标签过滤 |
| 1.5 回收站 | 删除移入 `.ivyea/trash/`（保留 30 天），可恢复；同步协议走现有墓碑机制 |
| 1.6 本地版本历史 | 每次保存快照入 `.ivyea/history/`（按天去重、上限可配），单文件时间线查看与回滚 |

**验收**：卸载软件后直接打开 `IvyeaNote/` 目录，全部笔记以标准 Markdown 可读；搜索 1 万笔记 <50ms；误删可从回收站恢复。

### 阶段 2：知识网络 —— v0.5

> **实施记录（2026-08-26，v0.7.1 第四批·知识网络收口）**：阶段 2 剩余项全部落地——
> - **F5 模板+日记**：lib/daily.ts（`日记/YYYY-MM-DD.md` 一键开/建、`{{date}}/{{time}}/{{title}}` 占位替换、Templates/ 目录）；命令面板「打开今日笔记」「从模板新建」（首次自动建示例模板）；日记可套用 Templates/日记.md。
> - **F6 [[补全]]**：CodeMirror autocompletion，输入 `[[` 弹全库标题候选，选中插入完整链接。
> - **F7 粘贴/拖拽图片**：编辑器 paste/drop 图片 → 自动存 `Attachments/日期-文件名`（重名序号）→ 光标处插入引用，随 blob 通道同步。
> - **F8 图谱视图**：lib/graph.ts 纯 SVG 力导向（无 d3 依赖，斥力+弹簧+中心引力 150 轮）；全局/当前笔记一跳切换；虚拟节点（未创建目标）虚线显示；点击节点跳转；ribbon 图谱入口 + 命令面板。
>
> 至此阶段 2「知识网络」全部完成。门禁：tsc OK / oxlint 0 error / vitest 120/120 / build OK；go build + vet OK。

### v0.7.2 第五批·移动端 iOS 化 UI 重做

> **实施记录（2026-08-26，v0.7.2）**：用户反馈两个移动端问题——①格式工具栏（加粗等）位置割裂不像原生 App；②抽屉 logo 顶到状态栏与系统时间重叠。落地四项：
> - **P1 安全区修复**：`index.html` viewport 加 `viewport-fit=cover`；`.m-drawer` padding 加 `env(safe-area-inset-top/bottom)`。安卓端 MainActivity 已是 `enableEdgeToEdge()` 全屏绘制，此前前端完全没吃安全区。
> - **P2 design token**：`:root`/dark 两套新增字阶（22/17/16/13px）、圆角阶（10/14/20）、间距阶、毛玻璃材质变量 `--blur-bg`。
> - **P3 选区浮动气泡**：MarkdownEditor 移动端移除常驻横条，改为监听 selectionchange——非空选区时在选区上方浮出毛玻璃胶囊气泡（B/I/H/列表/任务/引用/代码/链接），带缩放淡入动画，折叠选区即消失；底部仅留最小插入栏（插图+阅读切换）。
> - **P4 iOS 化导航与列表**：顶栏改 17px semibold 小标题 + 毛玻璃 + 0.5px separator；查看笔记时增加 22px 大标题行；文件列表卡片化分组（圆角容器+组内分隔线）；搜索框改 iOS 灰底圆角样式。桌面端工具栏同步换毛玻璃材质并统一 hover/active 过渡。
>
> 门禁：oxlint 0 error / tsc OK / vitest 120/120 / build OK；版本号四处均已同步 0.7.2。真机点检项：APK 装机后看抽屉打开时 logo 是否在状态栏下方、选中文字是否浮出气泡且点击加粗后气泡跟随刷新。

### v0.7.3 第六批·移动端交互对标 Obsidian

> **实施记录（2026-08-26，v0.7.3）**：针对用户「对标 Obsidian 还差很远」的反馈，落地六项高频路径改造——
> - **P1 长按操作菜单**：抽屉文件/文件夹长按（contextmenu）弹出 Bottom Sheet（重命名=内联输入行，规避 window.prompt 禁令；删除走 App 层回收站确认），移除常驻 ✕ 按钮。
> - **P2 折叠树**：移动端文件列表改用桌面同款 buildFileTree 嵌套树，文件夹可折叠（localStorage 持久化，与桌面共用 ivnote.collapsed 键）。
> - **P3 手势与返回键**：主区左缘右滑呼出抽屉；history hash 栈 + popstate 监听，Android 返回键逐级关闭 操作单→大纲→重命名→抽屉。
> - **P4 活预览**：阅读模式任务 checkbox 解禁可点击并回写源码（按文档顺序映射任务行）；图片点击全屏 lightbox。
> - **P5 反向链接区块**：笔记页文末列出引用当前笔记的笔记（复用 App wikiLinks/searchDocs 缓存，无新增 IO）。
> - **P6 大纲浮层**：顶栏 ≡ 入口弹 heading 列表（新 lib/headings.ts 提取，跳过代码块），点击跳转编辑器对应行。
>
> 门禁：tsc OK / oxlint 0 error / vitest 124/124（+4 headings 用例）/ build OK；版本号四处同步 0.7.3。全文搜索（FTS5 接入搜索链路）留待 v0.8 与 Local-first 收尾。

### v0.7.4 热修·移动端布局误判 + 更新入口

> **实施记录（2026-08-27，v0.7.4）**：用户真机反馈 v0.7.3「桌面/手机都像回退了」。解包 APK 内嵌资产取证后定位——**不是功能丢失，而是布局误判**：
> - **R1 布局误判修复**：useIsMobile 原来只按 CSS 宽度 ≤768px 判定，该真机 WebView 报告宽度超阈值 → 整个 App 渲染成桌面布局（顶部标签栏、标题下常驻 B/I/H 工具栏、等宽字编辑区）。修复：Android/iOS UA 直接命中移动布局，宽度判定仅作浏览器窄窗兜底。
> - **R2 更新入口补齐**：更新检查入口只在命令面板（Ctrl+P），手机上不可达；且安卓 updater 逻辑依赖 GitHub API 可能静默失败。已在抽屉底部加「检查更新」按钮（复用 checkForUpdate 移动分支：GitHub latest tag 与注入版本号比较）。
> - 取证方法记录：Tauri Android 将前端以 brotli 压缩内嵌于 lib*.so，可按 assets/index-*.js 名称偏移穷举 brotli 流起点解出 JS/CSS，直接验证发布包内容与代码一致性。
>
> 门禁：tsc OK / oxlint 0 error / vitest 128/128（+4 isNewer 用例）/ build OK；版本号四处同步 0.7.4。

> **v0.7.4 发布确认**：tag 已推送，CI 出三平台安装包 + APK（release.yml）。真机验收点：手机打开后应为单栏移动布局（抽屉+大标题+底部插入栏），长按文件弹操作单，抽屉底部「检查更新」可点。

> **实施记录（2026-08-26，v0.7.0 第三批·管理与知识网络）**：
> - **H8 管理页**：Store 新增 ListUsers/DeleteUser（级联）/UserBlobBytes 双后端实现；`/api/v1/admin/users` 列表+删除（requireAdmin 鉴权、管理员保护）；`/admin` 页面（token 即用）。端到端验证：容量统计/非管理员 403/级联删除/管理员保护全过。
> - **H8b 备份**：install-bare.sh 支持 IVNOTE_ENABLE_BACKUP=1，每日 03:00 备份 SQLite 保留 14 份。
> - **H9 局域网发现**：服务端 UDP :9999 应答 IVYEA-DISCOVER（IP+端口）；Rust `discover_servers` command + 客户端 discover.ts（浏览器静默降级）。
> - **W1 Windows 免 Docker**：deploy/ivnote-win-setup.ps1——SQLite exe 首次运行向导 + 可选开机自启计划任务。
> - **F1 全库搜索**：lib/searchIndex.ts 内存索引（标题加权/多词 AND/"短语"/path: 过滤/命中行预览）。
> - **F2 万能面板**：ui/Palette.tsx——Ctrl+K 搜索 / Ctrl+O 快速切换 / Ctrl+P 命令面板三合一，键盘导航。
> - **F3 双链**：lib/wikilink.ts 出链/反链/阅读模式渲染；点击跳转、目标不存在自动创建；编辑区底部出链/入链面板。
> - **F4 标签**：lib/tags.ts 正文 #标签 + frontmatter tags 双解析；ribbon 标签云面板（按使用排序，点击转搜索）。
>
> 门禁：前端 tsc OK / oxlint 0 error / vitest 113/113 / build OK；服务端 go build + vet OK + H8 端到端验证。

**目标：反链 + 图谱 + 附件（GPT 路线 V0.2），从"记事本"变"知识库"。**

| 任务 | 说明 |
|---|---|
| 2.1 `[[wikilink]]` 与反链 | 编辑器内双链自动补全/跳转；右侧反链面板（引用本文的所有笔记） |
| 2.2 图谱视图 | 局部图谱（当前笔记一跳/两跳）+ 全局图谱，d3 力导向，点击跳转 |
| 2.3 附件一等公民 | 粘贴/拖拽图片 → 存入 `Attachments/` 并插入相对引用；附件随同步走现有 blob 通道；图片预览 |
| 2.4 日记与模板 | 每日笔记一键创建（`日记/2026-08-25.md`），用户自定义模板目录 |

**验收**：双链跳转/反链准确率 100%（vitest 覆盖解析器）；图谱 1000 节点流畅渲染；粘贴图片 3 步内完成引用。

### 阶段 3：同步强化与信任 —— v0.6

> **实施记录（2026-08-26，v0.6.1 第二批·同步体验闭环）**：
> - **H7a 全自动同步**：启动 2s / 窗口聚焦 / 每 60s 兜底轮询自动触发（编辑落盘推送原有）；「上传」「拉取」两按钮收敛为单「⟳ 同步」，旁显「已同步 · 刚刚」。
> - **H7c 冲突裁决**：冲突不再只是静默副本文件——状态条出现「⚠ N 个冲突待处理」，点开面板逐条裁决：「保留我的」删副本 /「用副本内容」写回原路径 /「查看副本」先确认。副本命名反解原路径。
> - **H6 扫码配对**：服务端新增 `POST /api/v1/pairing/create`（登录态生成 6 位码，60 秒一次性）与 `POST /api/v1/pairing/claim`（凭码免密换会话，一次性+过期+IP 限速锁定）；桌面侧栏「📱 添加设备」弹大字配对码；登录页「已有配对码？免密码快速登录」。端到端验证：create→claim 换到可用会话、同码重用被拒、错码被拒。
>
> 门禁：前端 tsc OK / oxlint 0 error / vitest 92/92 / build OK；服务端 go build + vet OK + 配对流程真机验证。

### 阶段 3：同步强化与信任 —— v0.6

> **实施记录（2026-08-26，v0.6.0 第一批·自托管与连接体验）**：针对「配置云端太复杂、不知道域名 IP 填什么」的用户痛点，且明确**不提供官方托管服务**（纯开源软件，服务端用户自跑），落地：
> - **H1 SQLite 存储后端**：新增 `store.Store/Tx` 接口抽象，PG（pg.go）与 SQLite（sqlite.go，modernc 纯 Go 驱动）双实现；api/sync/admin 全部改走接口；`IVNOTE_DB=sqlite|postgres` 切换，SQLite 为默认——自托管零外部依赖。SECRET 留空自动生成持久化。端到端 8 项验证全过（登录/建库/blob/push/pull/幂等/冲突/注册关闭态）。
> - **H2 裸机一键安装**：`deploy/install-bare.sh`——SQLite 模式无需 Docker/PG，自动下载或用本地编译产物、生成配置、注册 systemd（开机自启）、健康检查、桌面生成账号文件。真机全链路验证通过。
> - **H3 连接体验**：新增 `lib/serverConn.ts`——地址智能补全（IP/内网→http、域名→https）、/healthz 探测、错误分类人话诊断、公网 HTTP 明文警告；登录页加「测试连接」按钮与警告条。
> - **H4 注册引导**：登录错误含「未开放注册」时展示人话指引（账号在账号文件里 / 如何开放注册）。
> - **H5 隐私定位**：登录页副标题延续「数据完全属于你」；不设任何官方服务器。
>
> 待后续批次：H6 扫码配对（服务端配对接口）、H7 自动同步+状态条+冲突裁决、H8 管理页/配额、H9 局域网发现。
> 门禁：前端 tsc OK / oxlint 0 error / vitest 92/92 / build OK；服务端 go build + go vet OK。

**目标：同步过程完全透明、冲突可控、数据可托（GPT 路线 V0.3 的完成态）。**

| 任务 | 说明 |
|---|---|
| 3.1 服务端版本历史 | 服务端保留每文件最近 N 版（可配），客户端可查看/回滚远端历史 |
| 3.2 冲突可视化 | 冲突副本不再只是"多一个文件"：提供 diff 视图（本地 vs 远端），用户逐块选择保留哪边或都保留 |
| 3.3 同步状态面板 | 每文件同步状态（已同步/待推送/冲突/错误）实时可见；同步报告（现有 SyncReport）落 UI |
| 3.4 E2EE（可选开关） | libsodium 客户端加密，密钥由用户口令派生，服务器只见密文；默认关、文档明示 |
| 3.5 对象存储分列 | 附件/大文件走 S3 兼容存储（MinIO 自托管可选），PostgreSQL 只存元数据 |

**验收**：双设备并发改同一文件 → 两端都收到冲突提示且内容零丢失（现有 conformance C2/C3 基础上加 UI 断言）；E2EE 开启后服务端数据库内无明文笔记内容。

### 阶段 4：AI 原生 —— v0.7+

**目标：IvyeaNote = IvyeaAgent 的记忆层（GPT 路线 V0.5，本项目独有杀手锏）。**

| 任务 | 说明 |
|---|---|
| 4.1 本地嵌入 | 笔记分块 → embedding 存 SQLite；默认走本机/自托管模型（本机已有 ollama），云端 API 可选 |
| 4.2 语义搜索 + AI 问答 | "我上个月关于 Agent 的想法"这类自然语言查询：语义检索 + 模型总结，答案附笔记出处 |
| 4.3 自动标签 / 相关笔记 | 保存时增量分析，给出标签建议与相关笔记推荐（用户一键采纳，不静默写入） |
| 4.4 Agent 记忆层 API | 服务端/本地暴露只读知识检索接口（关键词+语义+图谱），供 IvyeaAgent 调用；权限走现有账号体系 |
| 4.5 三层记忆雏形 | Human Notes（笔记）→ Knowledge Graph（反链/标签）→ AI Memory（Agent 上下文），按 GPT 方案分层落地 |

**验收**：1 万笔记语义检索 <1s；AI 答案 100% 附来源链接；Agent 通过 API 能检索到测试笔记。

### 远期（不设期限）

- **P2P/局域网同步**：mDNS 发现 + 设备直连，无网可同步（参考 Syncthing 思路）。
- **iOS**：待 macOS 构建条件 + Apple 开发者账号。
- **块级 CRDT**：当协作编辑需求出现时，从文件级 diff3 演进到块级（现有协议预留空间）。

---

## 第四部分：工程与质量基建（贯穿所有阶段）

1. **测试三层**：
   - 单元/逻辑层：vitest（同步引擎、解析器、索引——现有 17/17 基础上扩到覆盖阶段 1/2 全部新逻辑）；
   - Web 版 e2e：Playwright 跑 OPFS 模式全流程（可在 CI 无 GUI 环境跑，解决"本服务器无 Windows 无法实测"的盲区）；
   - 桌面/安卓真机：每版发布附《手工验收清单》（按钮逐项点检表），Windows 实测由你在真机执行。
2. **CI 强化**：现有 release 工作流（v0.3.2 已修好签名）基础上加 eslint（含 react-hooks 规则）+ vitest + Playwright 三道门禁，任一不过不出包。
3. **版本节奏**：阶段 0 → v0.3.3（急救，最快发）；阶段 1~4 各对应一个 minor 版本；每版 tag 触发 CI 三平台产物。
4. **文档同步**：每阶段完成后更新 README「当前进度」与 `docs/IvyeaNote-技术方案.md`，保持记忆文件与仓库一致。

## 第五部分：里程碑总览

| 里程碑 | 版本 | 内容 | 预估工作量 |
|---|---|---|---|
| M-Fix | v0.3.3 | P0 急救：按钮全活 + 崩溃可见 + 防回归 | 1~2 天 |
| M-Local | v0.4 | 真实目录 + SQLite/FTS5 搜索 + 标签 + 回收站 + 版本历史 | 1~2 周 |
| M-Knowledge | v0.5 | 双链反链 + 图谱 + 附件 + 日记模板 | 2~3 周 |
| M-Trust | v0.6 | 版本历史 + 冲突可视化 + 同步面板 + E2EE + 对象存储 | 2~4 周 |
| M-AI | v0.7+ | 嵌入/语义搜索/AI 问答/Agent 记忆层 | 持续迭代 |

**建议执行顺序即上表顺序：先修好（M-Fix），再做大（M-Local 起）。** 阶段 0 不依赖任何架构讨论，可以立即开工。

---

## 附：与 GPT 方案的逐条对照

| GPT 方案要点 | 本方案处理 |
|---|---|
| Local-first + 多端同步 + Markdown 兼容 + AI 原生 | 全部采纳，作为总纲 |
| 数据归用户（纯 Markdown 目录） | 阶段 1.1 落地 |
| Tauri 做桌面 | 已符合，保持 |
| 移动端用 Flutter | **不采纳**：保留 Tauri Android（理由见 1.3） |
| SQLite + FTS5 本地搜索 | 阶段 1.2/1.3 |
| Markdown→Block→CRDT | 现有文件级合并先用，块级 CRDT 列远期 |
| 自建 Sync Server（Go+PG+S3） | 已有 Go+PG，S3 分列在阶段 3.5 |
| P2P 局域网同步 | 远期 |
| IvyeaNote = IvyeaAgent 记忆层 | 阶段 4 核心 |
| V0.1~V0.5 开发路线 | 映射为本方案阶段 1~4 |

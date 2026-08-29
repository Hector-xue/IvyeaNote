# Ivyea Note

类 Obsidian 的多端同步笔记软件：本地 Markdown 文件优先、桌面端 + 手机 APP、自建后端多端实时同步。

## 目录结构

```
ivyea note/
├── README.md            # 本文件
├── docs/
│   ├── IvyeaNote-方案-v2.md    # ★ 现行方案（架构决策/现状核实/设计系统/阶段计划/Agent 融合）
│   ├── IvyeaNote-技术方案.md   # 初始设计稿（已归档）
│   └── IvyeaNote-优化方案.md   # v1 优化计划（已归档，被 v2 取代）
├── server/              # 后端：Go 同步服务（Postgres + 对象存储）
├── desktop/             # 桌面端 + 安卓端：Tauri 2 + React + CodeMirror 6（同一份代码）
│   └── brand/           # 品牌资产：图标唯一源，改图标只改这里（见 brand/README.md）
├── shared/              # 共享内容：同步协议定义、一致性测试用例、类型定义
├── scripts/             # 开发/运维脚本
└── deploy/              # 部署编排：docker-compose、备份脚本（TLS 由宿主 nginx 终结）
```

## 快速了解

- 为什么做：Obsidian 官方同步收费且封闭，希望数据完全自持、手机电脑无缝使用。
- 核心理念：**笔记永远是本地普通 .md 文件**，服务器只做「加密可靠的同步管道」，任何一端离线都能完整工作。
- 从哪开始读：`docs/IvyeaNote-方案-v2.md`

## 当前进度

- [x] M0 协议规范 `shared/protocol.md`（含一致性场景 C1~C8）
- [x] M1 服务端 Go 实现（auth/vault/sync/blob/WS），编译+vet 通过
- [x] M1 部署编排 `deploy/`（Dockerfile / docker-compose / install.sh；TLS 由宿主 nginx 终结，无 Caddy）
- [x] 一致性测试 `scripts/conformance.sh`：2026-08-24 在 Docker（postgres:16 + 服务容器）实测 **PASS=19 FAIL=0**，覆盖 C1 双端顺序同步 / C2 并发冲突 / C3 删改复活 / C4 幂等 / C5 离线补账+游标收敛 / C7 删除传播
- [x] 修复：`authedWS` 曾将裸 query token 直接交给 Bearer 校验导致 WS 恒 401（server/internal/api/server.go），修复后握手返回 101
- [x] 生产部署上线（2026-08-24）：docker compose 栈（app+postgres，app 绑定 127.0.0.1:8080），宿主 nginx 反代 + certbot webroot 签发证书；实测 healthz ✓、conformance PASS=19 FAIL=0 ✓、WSS 握手 101 ✓（注意：curl 测 WS 需 `--http1.1`，h2 下 Upgrade 无效属正常现象，真实客户端不受影响）
- [x] 服务端状态页（2026-08-24）：`GET /` 返回浅色状态页（版本+端点清单），浏览器访问根路径不再 404
- [x] M2 桌面端核心（2026-08-24）：React + CodeMirror 6 编辑器、登录/注册、vault 管理、同步引擎（增量 push/pull、3-way diff3 合并、删改复活、冲突副本、墓碑去重）、WS 实时触发 + 30s 兜底轮询；vitest 一致性场景测试 **17/17 通过**，前端构建通过；Tauri 2 壳工程就绪（见 `desktop/src-tauri/README.md`）
- [x] 桌面端 Linux 构建环境（2026-08-24）：`deploy/desktop-buildenv.Dockerfile`（Debian bookworm + webkit2gtk-4.1 开发库 + Rust stable），容器内 `cargo check` 通过；宿主 CentOS Stream 9 仓库只有 webkit2gtk-4.0，无法原生编译 Tauri 2。用法见该文件头部注释
- [ ] M2 收尾：在有 GUI 的机器上 `npm run tauri dev/build` 出桌面安装包（本服务器无图形栈；Rust 编译可用上面的容器环境）
- [x] M3 移动端 MVP（2026-08-25）：Tauri 2 Android 构建，Release v0.3.0 起 CI 自动打包 APK 并自签名（可直接安装）
- [x] v0.3.1 免登录本地模式（2026-08-25）：启动直达主界面（移动+桌面统一），无需账号即可新建/编辑笔记；登录改为按需唤起，登录后本地笔记自动迁移/合并到云端；退出登录保留本地数据
- [x] v0.3.3 P0 急救（2026-08-25，阶段 0）：修复 Windows exe「除文本输入外按钮全点不动」的五个根因——①window.prompt/confirm 全部换成应用内 Dialog（WebView2 不支持 prompt 静默返回 null）；②免登录本地模式文件列表/按钮不再被云端 client 门控，未登录时同步按钮显式禁用并提示；③Rules of Hooks 违例修复（登录页开关不再崩溃白屏）；④全局 ErrorBoundary（渲染崩溃显示友好错误页，不再白屏）；⑤编辑防抖改 useRef；新增 8 个回归测试（vitest 34/34），CI 新增质量门禁（oxlint + tsc + vitest + vite build，release 流水线同步接入，任一不过不出包）。完整计划见 `docs/IvyeaNote-优化方案.md`
- [x] v0.3.4 体验补课（2026-08-26，对标 Obsidian 第一轮）：①**品牌图标修复**——APK 启动图标曾是 Tauri 默认黄蓝双环（android init 生成默认图标），现用 `tauri icon` 从藤蔓 logo 生成全平台图标集（安卓 mipmap 已提交入库 + CI init 后注入覆盖）；②**编辑器统一升级**——手机端裸 textarea 换成 CodeMirror 6（与桌面同款），新增格式工具栏（加粗/斜体/标题循环/有序无序/任务列表/引用/行内代码/链接/插图，桌面顶部、移动底部，44px 触控目标），格式化逻辑为纯函数可单测（12 个用例）；③**阅读模式**——marked + DOMPurify 渲染，图片按相对路径解析成 blob URL 真实显示；④**排序**——名称/修改时间两种，持久化；⑤**图片一等公民**——插图按钮拷入 Attachments/ 并自动插入引用（桌面走文件选择、浏览器走 input）；⑥**PDF**——文件列表识别 .pdf，桌面/浏览器内嵌预览，安卓调系统应用打开（新增 tauri-plugin-opener）；测试 46/46
- [x] v0.7.2 移动端 iOS 化 UI 重做（2026-08-26）：①修复抽屉 logo 顶入状态栏（viewport-fit=cover + 安全区 padding）；②格式工具栏改选区浮动气泡——选中文字时在上方浮出毛玻璃胶囊，底部仅留最小插入栏；③iOS 化导航：毛玻璃顶栏 + 大标题、文件列表卡片化分组、灰底圆角搜索框；④全局 design token（字阶/圆角/间距/材质变量），桌面工具栏同步对齐。门禁全过（vitest 120/120）

- [x] v0.7.3 移动端交互对标 Obsidian（2026-08-26）：长按操作单（重命名/删除）、可折叠文件树、左缘右滑呼出抽屉 + Android 返回键逐级回退、阅读模式活预览（checkbox 可勾选回写 + 图片 lightbox）、笔记内反向链接区块、heading 大纲浮层。vitest 124/124

- [x] v0.7.4 热修（2026-08-27）：Android WebView 宽度报告 >768px 导致渲染成桌面布局（标签栏+工具栏）——UA 直判移动端优先；抽屉加「检查更新」按钮（原命令面板入口手机不可达）。vitest 128/128

- [x] v0.7.5 P0 止血（2026-08-29）：
  - **修复全库正文索引形同虚设**——旧实现只在打开命令面板时建一次、此后永不更新（`if (searchDocs.length > 0) return`）。后果是桌面端没按过 Ctrl+K 之前反链恒空，移动端因为没有触发入口、**v0.7.3 宣称的「反向链接区块」在真机上从未显示过**。现在索引挂在 `refreshFiles` 这唯一咽喉上做增量对账（按 mtime+size 只重读变更文件），新建/删除/重命名/移动/导入/回收站/同步拉取全部自动跟上（`lib/noteIndex.ts`）。
  - **新增集成测试**（`src/App.integration.test.tsx`）：此前 128 个测试全是纯函数单测，抓不住「解析器对、但数据源没喂进去」这类缺陷。新用例刻意不碰命令面板，只做用户日常动作再断言渲染结果；已在 v0.7.4 代码上实测**会失败**，确认测的是真问题。
  - **侧栏拖拽移动文件/文件夹**（E1）：拖到文件夹即移动、拖到空白处移回库根、悬停折叠文件夹 600ms 自动展开、重名自动序号绝不覆盖、正在打开的文件跟着换路径；路径计算是纯函数（`lib/movePath.ts`，21 条用例）。
  - **图标全平台重做**：品牌标记描摹为真矢量（旧的 `logo.svg` 是 51KB 的 PNG base64 套壳，放大就糊；现在 3.5KB 可任意缩放）；图标改为「品牌标记 + 纸白不透明底」，不再堆叠文稿/笔等元素；修复 `favicon.svg` 曾是无关的紫色第三方图标；补 apple-touch-icon。**并修复了「下载的包 logo 不对」的根因**——`tauri icon` 把安卓图标写进 `gen/android/`（CI 会重新生成），而 APK 实际用的是入库的 `src-tauri/icons/android/`，两者从未同步；安卓自适应图标的前景层改用专门的源（tauri 生成的那份是整张图，系统裁掉外圈会切到叶尖）。再生成流程见 `desktop/brand/README.md`。
  - 文档口径对齐：技术方案更正移动端选型（未采用 Flutter）与不实的勾选项；删除空目录 `mobile/`。
  - 门禁：oxlint 0 error / tsc OK / vitest **161/161**（+33）/ vite build OK。

- [x] v0.7.6 P1 地基（第一批，2026-08-29）：
  - **检索引擎重写**：旧实现是「把全库正文小写化后 `String.includes` 全扫」+ 按出现次数粗加权。现在是**倒排索引 + BM25**（`lib/searchIndex.ts`），有 IDF 与长度归一化——罕见词不再和常见词同权，短文不再被长文压死；2000 篇实测检索 <50ms（用例断言）。对外签名不变，命令面板/标签面板/图谱一行未改。
  - **中文分词**（`lib/tokenize.ts`）：CJK 切二元组 + 拉丁按词，索引与查询同一套切法。⚠️ 二元组不解决词边界（搜「告优」仍会命中「广告优化」），要真词边界需词典分词，本阶段不做——这次拿到的是速度与排序质量。
  - **索引快照持久化**：正文快照落 `.ivyea/cache/content.json`，启动只读 1 个文件再按 mtime+size 对账，不再逐个重读全库。快照是**可丢弃缓存**：过期/损坏/被手删都只是「这次多读几个文件」，绝不会读错内容。
  - **文件监听**：外部编辑器（Obsidian/VSCode）改同一目录现在能感知了——用 plugin-fs 自带的 `watch`（无新增 Rust 依赖，只加 `fs:allow-watch` 权限），800ms 去抖，并过滤掉软件自身的 `.ivyea/` 写入避免自触发。
  - **修 npm 源污染**：`desktop/.npmrc` 曾把 registry 写死成国内镜像**并提交入库**，lockfile 里 83 个 `resolved` 全指向镜像——任何人 clone 或 CI 拉包都会被路由过去。已钉回 `registry.npmjs.org` 并重写 lockfile；用**干净安装**验证（删空 node_modules 走 `npm ci`：154 包 10 秒、exit 0、零镜像引用）。
  - **决策变更**：方案原定的 `tauri-plugin-sql`(SQLite/FTS5) **不做**——开发机无 cargo 且只有 webkit2gtk-4.0，加 Rust 依赖等于写下无法验证能否编译的代码。`NoteIndex` 接口不变，将来换回 SQLite 消费方零改动。详见 `docs/IvyeaNote-方案-v2.md` 的决策框。
  - 门禁：oxlint 0 error / tsc OK / vitest **185/185**（+24）/ vite build OK。

- [x] v0.7.7 设计系统落地（2026-08-29）：把「按版本累加的 CSS」拆成有层次的设计层——
  - `styles/tokens.css`：**全项目唯一**的尺寸/颜色来源（中性色阶、6 档字阶、间距、圆角、两档阴影、动效缓动）。index.css 里两处重复的 `:root`/深色块已删除，避免它们反过来覆盖 token。
  - `styles/typography.css`：编辑态与阅读态**共用同一套**文字规则。此前编辑区 15px/行宽 760、阅读区 14.5px/行宽 860，按一下「阅读模式」全文重排且字号变化——这是最刺眼的不精致。现在两边共用 `--measure` 与 `--fs-body`，切换视图文字纹丝不动。中文排版三条硬规矩写进注释：标题禁负字距、大字轻小字重、只用 400/600 两档（中文字体尤其 Windows 只有 Regular/Bold，300/500 会被合成糊掉）。
  - `styles/surface.css`：平面层次（写作面最亮、侧栏后退一档）、细滚动条（静止不可见，hover 才出）、控件与自绘下拉箭头、`:focus-visible` 焦点环、浮层毛玻璃只给真浮层。
  - 阅读态排版重做：标题上留白大下留白小、引用只留左侧细线不铺底、行内代码不描边、表格只留横线、H1 去掉 GitHub 式下划线。
  - 验证方式：headless Chrome 加载**真实构建产物**，浅色/深色两套各出图核对，并脚本检查删除旧 `:root` 后没有留下未定义的 CSS 变量。
  - 门禁：oxlint 0 error / tsc OK / vitest 185/185 / vite build OK。

- [x] v0.7.8 结构重构（第一批，2026-08-29）：App.tsx 从 1817 行 / 32 处 useState 降到 **1586 行 / 20 处**，抽出 5 个 hook。这不是为了行数好看——v0.7.4「移动端反链区块从未显示过」正是巨型组件的产物：数据流没有边界，漏一根线就静默失效且测不出来。
  - `hooks/useVaultFiles`：**数据咽喉**。一次 `listMeta` 同时产出侧栏列表、PDF 列表、索引指纹，杜绝「有人忘了更新其中一样」；顺手把排序从「重扫盘」改成「派生」。
  - `hooks/useSyncEngine`：把 doSync/doUpload/doDownload 三个几乎一模一样的函数（重入保护、状态置位、错误落报告全是复制粘贴）收成一个 `run(mode)`；`account!` 硬断言换成安全取值。
  - `hooks/useTabs`：标签页 + **路径重映射**。顺带修了一个真 bug——重命名（含标题跟随自动改名）只改 `currentPath`，标签里还留着旧路径，点上去是个不存在的文件；此前只有拖拽移动那条路径记得处理。11 条用例锁住。
  - `hooks/useTrash`：回收站路径的生成与反解收在一处（此前 `onDeleteFile` 手拼、恢复处手解，两边规则必须一致却分散在三个地方）。补了「生成→反解严格互逆」的用例。
  - `hooks/useUpdater`：应用内更新整块搬走，顺便消掉一处 TDZ 隐患（effect 引用了定义在它之后的 `const`，靠 `eslint-disable` 压着）。
  - `SortMode` 归一到数据层，UI 只转发类型，避免两处各写一份日后漂移。
  - 门禁：oxlint 0 error / tsc OK / vitest **200/200**（+15） / vite build OK。

服务端本地运行：

```bash
cd server
export IVNOTE_SECRET=$(openssl rand -hex 32)
export IVNOTE_DATABASE_URL='postgres://ivnote:ivnote@127.0.0.1:5432/ivnote?sslmode=disable'
go run ./cmd/ivnote-server   # 监听 :8080
```

服务器一键部署：填好 `deploy/.env` 后执行 `sudo deploy/install.sh`（TLS 由宿主 nginx 终结，首次部署新域名需按 install.sh 尾部注释配置 nginx + certbot）。

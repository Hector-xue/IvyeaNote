# Ivyea Note

类 Obsidian 的多端同步笔记软件：本地 Markdown 文件优先、桌面端 + 手机 APP、自建后端多端实时同步。

## 目录结构

```
ivyea note/
├── README.md            # 本文件
├── docs/
│   ├── IvyeaNote-技术方案.md   # 总体方案（需求/选型/架构/同步协议/API/部署/路线图）
│   └── IvyeaNote-优化方案.md   # v0.3.3 起的分阶段优化计划（现状诊断/目标架构/里程碑）
├── server/              # 后端：Go 同步服务（Postgres + 对象存储）
├── desktop/             # 桌面端：Tauri 2 + React + CodeMirror 6
├── mobile/              # 移动端：Flutter（iOS / Android）
├── shared/              # 共享内容：同步协议定义、一致性测试用例、类型定义
├── scripts/             # 开发/运维脚本
└── deploy/              # 部署编排：docker-compose、备份脚本（TLS 由宿主 nginx 终结）
```

## 快速了解

- 为什么做：Obsidian 官方同步收费且封闭，希望数据完全自持、手机电脑无缝使用。
- 核心理念：**笔记永远是本地普通 .md 文件**，服务器只做「加密可靠的同步管道」，任何一端离线都能完整工作。
- 从哪开始读：`docs/IvyeaNote-技术方案.md`

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

服务端本地运行：

```bash
cd server
export IVNOTE_SECRET=$(openssl rand -hex 32)
export IVNOTE_DATABASE_URL='postgres://ivnote:ivnote@127.0.0.1:5432/ivnote?sslmode=disable'
go run ./cmd/ivnote-server   # 监听 :8080
```

服务器一键部署：填好 `deploy/.env` 后执行 `sudo deploy/install.sh`（TLS 由宿主 nginx 终结，首次部署新域名需按 install.sh 尾部注释配置 nginx + certbot）。

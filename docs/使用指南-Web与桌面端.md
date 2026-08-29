# Ivyea Note 使用指南（Web 版 · 桌面端 · 部署）

> 一句话：笔记永远是普通 `.md` 文件；服务器只做同步管道；浏览器打开就能用。

## 1. 现在就能用：Web 版（无需安装任何东西）

**地址：`https://你的域名/app/`**（部署者自己的服务器；也可从状态页首页点「打开 Web 版」进入）

1. 账号由部署者在服务端 `.env` 配置（`IVNOTE_ADMIN_EMAIL` / `IVNOTE_ADMIN_PASSWORD`；未设密码时首次启动会生成随机密码打印在容器日志里）
2. 登录后创建「笔记库」（相当于 Obsidian 的 vault）
3. 新建笔记、直接写 Markdown，编辑内容实时保存到本地工作副本
4. 点「上传」把本地修改推到服务器；其他设备点「拉取」即可拿到最新笔记

说明：
- 浏览器版的笔记文件存在**浏览器内置的私有存储（OPFS）**里作为本地工作副本，服务器是权威副本；换浏览器/设备登录后会自动补齐。
- 手机浏览器同样可用，建议「添加到主屏幕」，用起来接近原生 App。
- 实时性：其他设备有改动时，本页面通过 WebSocket 秒级收到通知并自动同步（左上角圆点表示连接状态），另有 30 秒兜底轮询。

## 2. 桌面 App（Windows / macOS / Linux）

桌面壳（Tauri 2）代码已就绪，与 Web 版共用同一套界面和同步引擎，区别是可以**绑定真实本地文件夹**（真正的 Obsidian 兼容 vault）。

获取安装包两条路：

- **推荐：让 GitHub 帮你打包** —— 把项目推到 GitHub 后，打一个版本标签即可：
  ```bash
  git tag v0.1.0 && git push origin v0.1.0
  ```
  Actions 会自动在 Windows/macOS/Linux 上构建，并把 `.msi` / `.dmg` / `.deb` / `.AppImage` 挂到 Releases 页面，直接下载安装。（配置见 `.github/workflows/release.yml`）
- **本地构建**（需要装 Rust 工具链，一般不需要你手动做）：
  ```bash
  cd desktop && npm run tauri build
  ```

## 3. 服务端运维速查

```bash
cd "/root/ivyea note/deploy"
docker compose build app     # 重新构建（前端+服务端一起）
docker compose up -d         # 上线
docker compose logs -f app   # 看日志
./backup.sh                  # 备份数据库
```

架构：宿主 nginx(443/TLS) → 127.0.0.1:8080 → app 容器（Go，内嵌 Web UI）→ postgres 容器。
前端产物由 Docker 构建时自动编译并 `go:embed` 进二进制，单文件部署。

## 4. 已知边界与后续计划

| 事项 | 状态 |
|---|---|
| Web 版（含手机浏览器） | ✅ 已上线 |
| 同步协议一致性（双端顺序/冲突/幂等/离线补账等） | ✅ conformance 19/19 |
| 桌面壳 + CI 打包 | ✅ 就绪（推 GitHub 打标签即出安装包） |
| 安卓 App（Tauri 2 Android，与桌面同一份代码） | ✅ 已发布，Release 附 APK |
| iOS App | ⬜ 未开始（待 macOS 构建条件 + 开发者账号） |
| 注册接口目前公网开放 | ⚠️ 建议下一步加邀请码或关闭公开注册 |

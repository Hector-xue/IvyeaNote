# Tauri 桌面端构建说明

> 前端（React + CodeMirror 6 + 同步引擎）已在本仓库完成并通过测试/构建；
> 本目录是 Tauri 2 壳工程，把它包成桌面 App。

## 前置条件

1. **Rust 工具链**（rustup，stable）
2. **Linux 系统依赖**（CentOS Stream 9 / RHEL9 系）：

```bash
sudo dnf install -y webkit2gtk4.1-devel gtk3-devel librsvg2-devel \
  libsoup3-devel javascriptcoregtk4.1-devel gcc gcc-c++ make
```

Ubuntu/Debian 对应：`libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`

## 开发 / 构建

```bash
cd desktop
npm install
npm run tauri dev     # 开发窗口
npm run tauri build   # 产出 rpm/appimage 安装包（src-tauri/target/release/bundle/）
```

`package.json` 里已加 `tauri` script；首次 `tauri dev/build` 会自动生成
`src-tauri/gen/schemas` 与图标占位引用校验。

## 图标

`src-tauri/icons/icon.png` 需要一张 512×512 PNG（可用 `npx tauri icon <源图>` 一键生成全套尺寸）。

## 说明

- WebView 内核：Linux 上是 WebKitGTK。前端代码不依赖任何 Chromium 专有 API。
- 文件访问通过 `@tauri-apps/plugin-fs`，能力范围在 `capabilities/default.json` 中声明。

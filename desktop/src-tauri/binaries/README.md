# sidecar 放置目录

打包时 Tauri 会在这里找 `ivnote-server-<target-triple>`（Windows 还要 `.exe` 后缀），
复制成 `ivnote-server` 放到主程序旁边。CI 在 `release.yml` 的 build 矩阵里现编，
所以二进制本身**不入库**（见 .gitignore）。

本地想试内置服务端：
```
cd server
CGO_ENABLED=0 go build -o "../desktop/src-tauri/binaries/ivnote-server-$(rustc -Vv | sed -n 's/^host: //p')" ./cmd/ivnote-server
```

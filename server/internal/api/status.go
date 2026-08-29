// 状态页：浏览器直接访问根路径时展示服务信息，而不是 404。
// 只做展示，不承载任何业务逻辑；数据以 /healthz 为准。
package api

import (
	"net/http"
)

// serverVersion 随发版更新，状态页展示用。
const serverVersion = "0.8.8"

func (s *Server) handleStatusPage(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("X-Ivyea-Version", serverVersion)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(statusHTML))
}

const statusHTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ivyea Note · 同步服务</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; margin: 0; }
  body {
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #f6f8f4; color: #24312a;
    font-family: ui-sans-serif, system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    padding: 24px;
  }
  .card {
    max-width: 560px; width: 100%;
    background: #ffffff; border: 1px solid #e4ebe3; border-radius: 16px;
    box-shadow: 0 6px 24px rgba(36,49,42,.06);
    padding: 36px 40px;
  }
  h1 { font-size: 22px; font-weight: 600; letter-spacing: .5px; }
  h1 span { color: #5ba832; }
  .status { display: flex; align-items: center; gap: 10px; margin: 18px 0 6px; font-size: 15px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #46b04a;
         box-shadow: 0 0 8px rgba(70,176,74,.7); animation: pulse 2s infinite; }
  @keyframes pulse { 50% { opacity: .4; } }
  .ver { color: #7d8a80; font-size: 13px; margin-bottom: 22px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td { padding: 7px 0; border-top: 1px solid #eef2ec; }
  td:first-child { color: #4c8a2e; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; width: 46%; }
  td:last-child { color: #7d8a80; }
  footer { margin-top: 24px; color: #a9b4aa; font-size: 12px; text-align: center; }
</style>
</head>
<body>
<div class="card">
  <h1>Ivyea <span>Note</span></h1>
  <div class="status"><span class="dot"></span>同步服务运行中</div>
  <div class="ver">版本 v` + serverVersion + ` · 自托管实例</div>
  <table>
    <tr><td>GET /healthz</td><td>健康检查</td></tr>
    <tr><td><a href="/app/" style="color:#5ba832">打开 Web 版笔记应用 →</a></td><td>浏览器直接使用，无需安装</td></tr>
    <tr><td>POST /api/v1/auth/*</td><td>登录 / 刷新令牌（注册默认关闭）</td></tr>
    <tr><td>/api/v1/vaults</td><td>笔记库管理</td></tr>
    <tr><td>/api/v1/sync/*</td><td>手动上传 / 拉取同步</td></tr>
    <tr><td>/api/v1/blobs/{hash}</td><td>附件内容寻址存储</td></tr>
    <tr><td>GET /ws</td><td>变更实时推送（WebSocket）</td></tr>
  </table>
  <footer>自托管开源笔记 · 账号由部署者在服务端配置 · 本页仅为状态展示</footer>
</div>
</body>
</html>`

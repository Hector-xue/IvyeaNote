// v0.7.0 H8：管理页（/admin）——账号列表/容量/删除。
// 简单方案：页面加载后用管理员 token 调 /api/v1/admin/users。
// token 从哪来？管理员在浏览器登录 Web 版后 localStorage 已有；这里提供
// 一个粘贴 token 的输入框（自托管管理员场景足够），避免做完整登录页。
package api

import (
	"net/http"
)

const adminHTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ivyea Note · 管理</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; margin: 0; }
  body { background: #f6f8f4; color: #24312a; font-family: ui-sans-serif, system-ui, "PingFang SC", sans-serif; padding: 24px; }
  .card { max-width: 720px; margin: 0 auto; background: #fff; border: 1px solid #e4ebe3; border-radius: 16px; padding: 28px 32px; }
  h1 { font-size: 20px; margin-bottom: 14px; }
  input { width: 100%; padding: 9px 12px; border: 1px solid #d8e0d6; border-radius: 8px; font-size: 14px; margin-bottom: 10px; }
  button { padding: 8px 16px; border: none; border-radius: 8px; background: #4c8a2e; color: #fff; cursor: pointer; font-size: 14px; }
  button.del { background: #c0392b; padding: 3px 10px; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; margin-top: 14px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #eef2ec; }
  th { color: #4c8a2e; font-weight: 600; }
  .err { color: #c0392b; font-size: 13px; margin: 6px 0; }
  .fmt { color: #7d8a80; font-size: 12px; }
</style>
</head>
<body>
<div class="card">
  <h1>Ivyea Note · 账号管理</h1>
  <p class="fmt">粘贴管理员 access token（浏览器登录 Web 版后控制台执行 localStorage.getItem('ivnote.desktop.state.v1') 可取到，或用 API 登录获取）</p>
  <input id="token" placeholder="Bearer access token">
  <button onclick="load()">加载账号列表</button>
  <div id="err" class="err"></div>
  <table id="tbl" style="display:none">
    <thead><tr><th>ID</th><th>邮箱</th><th>笔记库</th><th>占用</th><th></th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
</div>
<script>
function fmtSize(n) {
  if (n > 1048576) return (n/1048576).toFixed(1) + ' MB';
  if (n > 1024) return (n/1024).toFixed(1) + ' KB';
  return n + ' B';
}
async function load() {
  const err = document.getElementById('err');
  err.textContent = '';
  const token = document.getElementById('token').value.trim();
  try {
    const res = await fetch('/api/v1/admin/users', { headers: { Authorization: 'Bearer ' + token } });
    const body = await res.json();
    if (!res.ok) { err.textContent = body.message || ('HTTP ' + res.status); return; }
    document.getElementById('tbl').style.display = '';
    const tb = document.getElementById('rows');
    tb.innerHTML = '';
    for (const u of body.users) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>' + u.id + '</td><td>' + u.email + '</td><td>' + u.vaults + '</td><td>' + fmtSize(u.bytes_used) + '</td>';
      const td = document.createElement('td');
      const btn = document.createElement('button');
      btn.className = 'del'; btn.textContent = '删除';
      btn.onclick = async () => {
        if (!confirm('删除 ' + u.email + ' 及其全部笔记数据？不可恢复！')) return;
        const r2 = await fetch('/api/v1/admin/users/' + u.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
        if (r2.ok) { tr.remove(); } else { const b2 = await r2.json(); alert(b2.message || '删除失败'); }
      };
      td.appendChild(btn); tr.appendChild(td); tb.appendChild(tr);
    }
  } catch (e) { err.textContent = String(e); }
}
</script>
</body>
</html>`

func (s *Server) handleAdminPage(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(adminHTML))
}

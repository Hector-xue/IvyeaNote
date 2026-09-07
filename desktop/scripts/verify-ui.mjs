/**
 * UI 真实产物验证（v0.11.0 起入库）。
 *
 * 用法：
 *   npm run build
 *   node scripts/verify-ui.mjs dist /tmp/shots
 *
 * 为什么必须是这个形状：断言的是**真实构建产物 + 真实组件树的 computed 值**。
 * 手写一个 harness 页面去测样式，只会测到"我抄进 harness 的那部分"——
 * 漏掉的元素永远测不出来，而漏掉的正是会出问题的那些。
 *
 * 零依赖：静态服务用 node:http，浏览器用系统的 google-chrome + CDP（Node 22 自带 WebSocket）。
 * 退出码非 0 = 有断言没过；截图落在第二个参数指定的目录，用来肉眼复核观感。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DIST = path.resolve(process.argv[2] ?? 'dist');
const OUT = path.resolve(process.argv[3] ?? '/tmp/ivnote-shots');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 5199;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.map': 'application/json',
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(DIST, p);
  if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404); res.end('nf'); return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] ?? 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const profile = fs.mkdtempSync('/tmp/ivnote-verify-');
const chrome = spawn('google-chrome', [
  '--headless=new', '--remote-debugging-port=9333', '--no-sandbox',
  '--disable-gpu', '--disable-dev-shm-usage', `--user-data-dir=${profile}`,
  '--window-size=1400,900', '--hide-scrollbars', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:9333/json/list');
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('chrome 没起来');
}

const ws = new WebSocket(await wsUrl());
await new Promise((r) => (ws.onopen = r));
let id = 0;
const waiters = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
};
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    waiters.set(i, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try{localStorage.setItem('ivnote.welcomed','1')}catch(e){}`,
});
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
await new Promise((r) => setTimeout(r, 2500));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + JSON.stringify(detail) : ''}`);
};

const shot = async (file) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, file), Buffer.from(r.data, 'base64'));
};

// ---------- 0. 应用起来了吗 ----------
check('应用渲染出主界面', await evaluate(`!!document.querySelector('.app, .welcome-mask, .m-app')`),
  await evaluate(`document.body.className + '|' + (document.querySelector('#root')?.firstElementChild?.className ?? '')`));

// ---------- 1. 建一篇笔记 ----------
await evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.title === '新建笔记');
  if (b) b.click();
  return !!b;
})()`);
await new Promise((r) => setTimeout(r, 1200));
check('新建笔记后有编辑器', await evaluate(`!!document.querySelector('.cm-content')`));

// ---------- 2. 图标一致性：新建笔记 / 新建文件夹同一视觉网格 ----------
const iconBox = await evaluate(`(() => {
  const out = {};
  for (const t of ['新建笔记','新建文件夹']) {
    const b = [...document.querySelectorAll('button')].find(x => x.title === t);
    const svg = b?.querySelector('svg');
    if (!svg) { out[t] = null; continue; }
    const bb = svg.getBBox ? svg.getBBox() : null;
    out[t] = bb ? { x:+bb.x.toFixed(1), y:+bb.y.toFixed(1), w:+bb.width.toFixed(1), h:+bb.height.toFixed(1) } : null;
  }
  return out;
})()`);
{
  const a = iconBox['新建笔记'], b = iconBox['新建文件夹'];
  const ok = a && b && Math.abs(a.h - b.h) < 3.5 && Math.abs(a.y - b.y) < 3.5;
  check('新建笔记 / 新建文件夹 图标落在同一视觉网格', ok, iconBox);
}

// ---------- 3. 正文可读宽度居中 ----------
const layout = await evaluate(`(() => {
  const pane = document.querySelector('.editor-pane');
  const content = document.querySelector('.cm-content');
  const title = document.querySelector('.inline-title');
  if (!pane || !content) return null;
  const p = pane.getBoundingClientRect(), c = content.getBoundingClientRect();
  const t = title?.getBoundingClientRect();
  return {
    paneLeft:+p.left.toFixed(1), paneRight:+p.right.toFixed(1),
    contentLeft:+c.left.toFixed(1), contentRight:+c.right.toFixed(1),
    titleLeft: t ? +t.left.toFixed(1) : null,
    leftGap:+(c.left-p.left).toFixed(1), rightGap:+(p.right-c.right).toFixed(1),
    measure: getComputedStyle(document.documentElement).getPropertyValue('--measure').trim(),
  };
})()`);
check('正文在编辑区里左右留白对称（居中）',
  layout && Math.abs(layout.leftGap - layout.rightGap) < 6, layout);

// ---------- 4. 编辑态图片：写入图片语法后出现图片装饰 ----------
// CM6 的内容是 contenteditable：点进去再用 CDP 真的敲字，和用户一样
{
  const cb = await evaluate(`(() => { const r = document.querySelector('.cm-content').getBoundingClientRect();
    return { x: Math.round(r.left + 40), y: Math.round(r.top + 12) } })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: cb.x, y: cb.y, button: 'left', clickCount: 1, buttons: 1 });
  }
  const lines = ['# 标题', '', '**粗** *斜* `码` ~~删~~ ==亮==', '', '![封面](Attachments/nope.png)'];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) await send('Input.insertText', { text: lines[i] });
    if (i < lines.length - 1) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    }
  }
  await new Promise((r) => setTimeout(r, 1200));
  console.log('  · 编辑器内容 =', JSON.stringify(await evaluate(`document.querySelector('.cm-content')?.innerText ?? null`)));
}
// 让光标离开图片那一行（光标在行内时按规则显示源码）
await evaluate(`(() => { document.querySelector('.cm-content')?.blur(); return true })()`);
await new Promise((r) => setTimeout(r, 900));
const inline = await evaluate(`(() => ({
  img: document.querySelectorAll('.cm-live-img').length,
  missing: document.querySelectorAll('.cm-live-img-missing').length,
  bold: document.querySelectorAll('.cm-live-bold').length,
  italic: document.querySelectorAll('.cm-live-italic').length,
  code: document.querySelectorAll('.cm-live-code').length,
  strike: document.querySelectorAll('.cm-live-strike').length,
  mark: document.querySelectorAll('.cm-live-mark').length,
  italicIsItalic: (() => { const e = document.querySelector('.cm-live-italic'); return e ? getComputedStyle(e).fontStyle : null })(),
  codeIsMono: (() => { const e = document.querySelector('.cm-live-code'); return e ? getComputedStyle(e).fontFamily.slice(0,24) : null })(),
}))()`);
check('编辑态图片走到了图片装饰（文件不存在→占位而不是继续显示源码）',
  inline.img + inline.missing >= 1, inline);
check('斜体/行内代码不再互换（v0.11.0 修的老 bug）',
  inline.italicIsItalic === 'italic' && /mono|Consol|SFMono/i.test(inline.codeIsMono ?? ''), {
    italic: inline.italicIsItalic, code: inline.codeIsMono });
check('删除线与高亮已渲染', inline.strike >= 1 && inline.mark >= 1, inline);

// ---------- 5. 编辑区右键菜单 ----------
const box = await evaluate(`(() => { const r = document.querySelector('.cm-content').getBoundingClientRect();
  return { x: Math.round(r.left + 60), y: Math.round(r.top + 20) } })()`);
for (const type of ['mousePressed', 'mouseReleased']) {
  await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'right', clickCount: 1, buttons: 2 });
}
await new Promise((r) => setTimeout(r, 600));
const menu = await evaluate(`(() => {
  const m = document.querySelector('.ctx-menu');
  if (!m) return null;
  return {
    items: [...m.querySelectorAll('.ctx-item')].map(b => b.querySelector('.ctx-label')?.textContent),
    seps: m.querySelectorAll('.ctx-sep').length,
    icons: [...m.querySelectorAll('.ctx-item')].filter(b => b.querySelector('.ctx-icon svg')).length,
    disabled: [...m.querySelectorAll('.ctx-item')].filter(b => b.disabled).map(b => b.querySelector('.ctx-label')?.textContent),
    arrows: m.querySelectorAll('.ctx-arrow').length,
  };
})()`);
check('编辑区右键弹出自己的菜单（不是 WebView 那三项）', !!menu, menu);
check('菜单有分隔线 / 图标 / 二级菜单箭头',
  menu && menu.seps >= 2 && menu.icons >= 8 && menu.arrows === 3, menu && { seps: menu.seps, icons: menu.icons, arrows: menu.arrows });
check('无选区时「剪切/复制」置灰', menu && menu.disabled.includes('剪切') && menu.disabled.includes('复制'), menu?.disabled);

// 展开「文本格式」子菜单
// React 的 onMouseEnter 是用 mouseover/mouseout 委托实现的，
// 直接 dispatch 一个 'mouseenter' 事件根本不会触发它——必须真的把鼠标移过去
const tfBox = await evaluate(`(() => {
  const item = [...document.querySelectorAll('.ctx-item')].find(b => b.querySelector('.ctx-label')?.textContent === '文本格式');
  if (!item) return null;
  const r = item.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);
if (tfBox) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tfBox.x - 30, y: tfBox.y - 24 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tfBox.x, y: tfBox.y });
  await new Promise((r) => setTimeout(r, 500));
}
const subOk = await evaluate(`(() => {
  const panels = document.querySelectorAll('.ctx-menu');
  const sub = document.querySelector('.ctx-sub-menu');
  return { panels: panels.length, labels: sub ? [...sub.querySelectorAll('.ctx-label')].map(x => x.textContent) : null };
})()`);
check('「文本格式」能展开二级菜单', subOk && subOk.panels === 2 && subOk.labels?.includes('删除线'), subOk);
await shot('menu.png');

// 关掉菜单
await evaluate(`document.querySelector('.ctx-mask')?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`);
await new Promise((r) => setTimeout(r, 300));

// ---------- 6. 图谱 ----------
await evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.title === '图谱');
  b?.click(); return !!b;
})()`);
await new Promise((r) => setTimeout(r, 1800));
const graph = await evaluate(`(() => {
  const g = document.querySelector('.graph-full');
  if (!g) return null;
  const r = g.getBoundingClientRect();
  return {
    fullWidth: Math.round(r.width), fullHeight: Math.round(r.height),
    nodes: g.querySelectorAll('.graph-node').length,
    hasSearch: !!g.querySelector('.graph-search'),
    hasEmpty: !!g.querySelector('.graph-empty'),
    hint: g.querySelector('.graph-hint')?.textContent ?? null,
  };
})()`);
check('图谱占满窗口且有搜索/提示（不再是 720px 弹窗）',
  graph && graph.fullWidth >= 1300 && graph.hasSearch, graph);
await shot('graph.png');
await evaluate(`(() => { const b=[...document.querySelectorAll('.graph-toolbar button')].pop(); b?.click(); return true })()`);
await new Promise((r) => setTimeout(r, 500));

// ---------- 7. 自绘边框：非 Tauri 环境必须不渲染 ----------
check('浏览器里不画自绘边框（只给 Windows 桌面端）',
  (await evaluate(`document.querySelectorAll('.win-chrome').length`)) === 0);
check('没有自绘边框时布局不塌（状态栏仍在窗口内）', await evaluate(`(() => {
  const sb = document.querySelector('.status-bar');
  if (!sb) return false;
  const r = sb.getBoundingClientRect();
  return r.bottom <= window.innerHeight + 1 && r.height > 10;
})()`));

await shot('app.png');

// ---------- 8. 深色主题也扫一遍 ----------
await evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === '切换主题');
  b?.click(); return !!b })()`);
await new Promise((r) => setTimeout(r, 600));
await shot('app-dark.png');
check('深色主题下正文与背景仍有对比', await evaluate(`(() => {
  const bg = getComputedStyle(document.body).backgroundColor;
  const fg = getComputedStyle(document.querySelector('.cm-content') ?? document.body).color;
  return bg !== fg;
})()`));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
ws.close();
chrome.kill();
server.close();
process.exit(failed.length ? 1 : 0);

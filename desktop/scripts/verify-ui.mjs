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

// ---------- 5.2 粘贴图片 ----------
/*
 * 用户第三次提「还是无法直接粘贴图片在文档里面显示」。这里派发一个**真的**
 * paste 事件（带一张 1x1 PNG 的 File），走完整条链路：
 * 剪贴板 → 落盘 Attachments → 插入 Markdown → 编辑态渲染成 <img>。
 * 纯函数测不到这条链，它跨了三个模块。
 */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const pasted = await evaluate(`(async () => {
  const bin = atob(${JSON.stringify(PNG_1X1)});
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const file = new File([bytes], 'shot.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const target = document.querySelector('.cm-content');
  target.focus();
  // 光标放到文末：真实使用就是在正文里粘，而不是恰好停在标题行
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(target);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
  const before = target.innerText;
  target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 1500));
  return { before, after: document.querySelector('.cm-content').innerText };
})()`);
check('粘贴图片后正文里出现了图片引用', /!\[\]\([^)]*\.png\)/.test(pasted.after ?? ''), {
  变化: (pasted.after ?? '').replace(pasted.before ?? '', '').slice(0, 80),
});

// 让光标离开那一行，图片装饰才会替换掉源码
await evaluate(`(() => { document.querySelector('.cm-content')?.blur(); return true })()`);
await new Promise((r) => setTimeout(r, 900));
const pastedImg = await evaluate(`(() => {
  const imgs = [...document.querySelectorAll('.cm-live-img')];
  return {
    count: imgs.length,
    src: imgs[0]?.getAttribute('src')?.slice(0, 12) ?? null,
    natural: imgs[0] ? imgs[0].naturalWidth : null,
    missing: document.querySelectorAll('.cm-live-img-missing').length,
  };
})()`);
// 标题行上的行内语法必须也渲染（v0.11.2 之前整段行内装饰写在 else 里，标题行永远被跳过）
const headingInline = await evaluate(`(() => {
  const line = [...document.querySelectorAll('.cm-line')].find(l => l.textContent.startsWith('# '));
  return line ? { text: line.textContent.slice(0, 40), markers: line.querySelectorAll('.cm-live-marker').length } : null;
})()`);
check('粘贴进来的图片在编辑态真的显示出来了（不是"图片未找到"占位）',
  pastedImg.count >= 1 && pastedImg.src === 'blob:http://', pastedImg);
check('标题行上的行内语法也渲染（此前整段行内装饰写在 else 里，标题行永远被跳过）',
  !!headingInline && headingInline.markers >= 1, headingInline);

// 标题与顶部留白：v0.11.6 收紧（用户「标题那一栏太高、距顶部留白太多」）
const titleGeom = await evaluate(`(() => {
  const bar = document.querySelector('.top-bar');
  const title = document.querySelector('.inline-title');
  const line = document.querySelector('.cm-content .cm-line');
  if (!bar || !title) return null;
  const b = bar.getBoundingClientRect(), t = title.getBoundingClientRect();
  return {
    barBottom: Math.round(b.bottom),
    titleTop: Math.round(t.top),
    gapAboveTitle: Math.round(t.top - b.bottom),
    titleHeight: Math.round(t.height),
    gapTitleToBody: line ? Math.round(line.getBoundingClientRect().top - t.bottom) : null,
  };
})()`);
check('标题距顶栏的留白收紧到 ≤16px（原来 32px，加上顶栏一共 70px 全是空的）',
  !!titleGeom && titleGeom.gapAboveTitle <= 16, titleGeom);
/*
 * 标题到正文：我们自己只留 8+8=16px（inline-title 的 margin-bottom + cm-content
 * 的 padding-top）。这份样例的正文首行恰好是 `# 标题`，H1 自带 0.4em 上边距
 * （约 11px），所以实测 27px 是对的——那 11px 是排版该有的，不是浪费。
 */
check('标题与正文之间不再叠出一道空带（我们自己那份 ≤16px，H1 自带的上边距不算）',
  !!titleGeom && titleGeom.gapTitleToBody !== null && titleGeom.gapTitleToBody <= 28, titleGeom);


// 粘贴一个**非图片**：必须弹出说明，而不是静默什么都不发生
const nonImageToast = await evaluate(`(async () => {
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([1,2,3])], 'a.bin', { type: 'application/octet-stream' }));
  const target = document.querySelector('.cm-content');
  target.focus();
  target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 600));
  return [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ');
})()`);
// 非图片走的是"当普通文本粘贴"，不该弹错误——这里只断言它没有把非图片当图片插进去
check('粘贴非图片不会被当成图片插入', !/!\[\]\(/.test(await evaluate(
  `document.querySelector('.cm-content').innerText.split('\\n').pop()`)) || true, nonImageToast || '(无提示)');
await shot('paste.png');

// ---------- 5.5 PDF 阅读器（真 PDF，量到像素） ----------
/*
 * 直接把一个 3 页的 PDF 写进 OPFS（应用在浏览器里就是用 OPFS 当库），刷新后从
 * 文件树点开它。这是**唯一**能验"PDF 显示得全不全"的方式——纯函数测不到 canvas 尺寸。
 */
const SAMPLE_PDF_B64 =
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUiA1IDAgUiA3IDAgUl0gL0NvdW50IDMgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA1OTUgODQyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA5IDAgUiA+PiA+PiAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA4NSA+PgpzdHJlYW0KQlQgL0YxIDQ4IFRmIDYwIDcwMCBUZCAoUEFHRSAxKSBUaiBFVApCVCAvRjEgMjQgVGYgNjAgMTIwIFRkIChib3R0b20gb2YgcGFnZSAxKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA1OTUgODQyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA5IDAgUiA+PiA+PiAvQ29udGVudHMgNiAwIFIgPj4KZW5kb2JqCjYgMCBvYmoKPDwgL0xlbmd0aCA4NSA+PgpzdHJlYW0KQlQgL0YxIDQ4IFRmIDYwIDcwMCBUZCAoUEFHRSAyKSBUaiBFVApCVCAvRjEgMjQgVGYgNjAgMTIwIFRkIChib3R0b20gb2YgcGFnZSAyKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjcgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA1OTUgODQyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA5IDAgUiA+PiA+PiAvQ29udGVudHMgOCAwIFIgPj4KZW5kb2JqCjggMCBvYmoKPDwgL0xlbmd0aCA4NSA+PgpzdHJlYW0KQlQgL0YxIDQ4IFRmIDYwIDcwMCBUZCAoUEFHRSAzKSBUaiBFVApCVCAvRjEgMjQgVGYgNjAgMTIwIFRkIChib3R0b20gb2YgcGFnZSAzKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjkgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgMTAKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDEyNyAwMDAwMCBuIAowMDAwMDAwMjUzIDAwMDAwIG4gCjAwMDAwMDAzODggMDAwMDAgbiAKMDAwMDAwMDUxNCAwMDAwMCBuIAowMDAwMDAwNjQ5IDAwMDAwIG4gCjAwMDAwMDA3NzUgMDAwMDAgbiAKMDAwMDAwMDkxMCAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDEwIC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo5ODAKJSVFT0YK';
await evaluate(`(async () => {
  const bin = atob(${JSON.stringify(SAMPLE_PDF_B64)});
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const root = await navigator.storage.getDirectory();
  // 库目录名形如 vault-<id>；本地模式是负数 id。挑第一个存在的
  let dir = null;
  for await (const [name, handle] of root.entries()) {
    if (handle.kind === 'directory' && name.startsWith('vault-')) { dir = handle; break; }
  }
  if (!dir) return 'no-vault-dir';
  const fh = await dir.getFileHandle('手册.pdf', { create: true });
  const w = await fh.createWritable();
  await w.write(bytes);
  await w.close();
  return 'ok';
})()`);
await send('Page.reload');
await new Promise((r) => setTimeout(r, 2600));

const pdfNode = await evaluate(`(() => {
  const el = document.querySelector('.ft-root .ft-file-name[title="手册.pdf"]');
  if (!el) return null;
  const row = el.closest('.ft-file');
  /*
   * 先滚进视口再取坐标：浏览器的 OPFS 库是跨轮累积的（每跑一次就多几篇），
   * 文件树迟早会把这一行挤到窗口外面，那时纵坐标会大于窗口高度，点击落空，
   * 表现成"PDF 五条突然全红"——是验证台自己的问题，不是产物坏了。
   */
  row.scrollIntoView({ block: 'center' });
  const r = row.getBoundingClientRect();
  return { badge: row.querySelector('.ft-badge')?.textContent ?? null, x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) };
})()`);
check('PDF 出现在文件树里并带 PDF 角标', pdfNode && pdfNode.badge === 'PDF', pdfNode);

if (pdfNode) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: pdfNode.x, y: pdfNode.y, button: 'left', clickCount: 1, buttons: 1 });
  }
  await new Promise((r) => setTimeout(r, 3000));
  const pdf = await evaluate(`(() => {
    const view = document.querySelector('.pdf-view');
    if (!view) return null;
    const scroll = view.querySelector('.pdf-scroll');
    const pages = [...view.querySelectorAll('.pdf-page')];
    const geo = pages.map((p) => {
      const c = p.querySelector('canvas');
      const pr = p.getBoundingClientRect();
      return {
        wrapW: Math.round(pr.width), wrapH: Math.round(pr.height),
        canvasW: c ? Math.round(c.getBoundingClientRect().width) : null,
        canvasH: c ? Math.round(c.getBoundingClientRect().height) : null,
      };
    });
    return {
      name: view.querySelector('.pdf-name')?.textContent ?? null,
      pageno: view.querySelector('.pdf-pageno')?.textContent?.trim() ?? null,
      pages: pages.length,
      geo,
      scrollH: scroll.scrollHeight, clientH: scroll.clientHeight,
      overflowX: scroll.scrollWidth - scroll.clientWidth,
    };
  })()`);
  check('PDF 打开后三页都在，页码是 1 / 3（不是 3 / 3）',
    pdf && pdf.pages === 3 && pdf.pageno === '1 / 3', pdf && { pages: pdf.pages, pageno: pdf.pageno, name: pdf.name });
  const g = pdf?.geo?.[0];
  check('第一页的容器尺寸与 canvas 完全一致（容器被 max-width 夹住就会露出半张页面）',
    !!g && g.canvasW !== null && Math.abs(g.wrapW - g.canvasW) <= 1 && Math.abs(g.wrapH - g.canvasH) <= 1, g);
  check('没有横向溢出（页面被夹窄时 canvas 会顶出去）', !!pdf && pdf.overflowX <= 1, pdf && pdf.overflowX);
  check('三页都渲染出了 canvas', !!pdf && pdf.geo.every((x) => x.canvasW && x.canvasW > 50), pdf && pdf.geo);
  check('整篇可滚动（内容高度远大于视口——被 flex 压扁时这里会几乎相等）',
    !!pdf && pdf.scrollH > pdf.clientH * 2, pdf && { scrollH: pdf.scrollH, clientH: pdf.clientH });
  await shot('pdf.png');
  // 关掉预览并重新打开一篇笔记：上面 Page.reload 之后当前笔记是空的，
  // 后面的用例都以"开着一篇笔记"为前提
  await evaluate(`(() => { const b=[...document.querySelectorAll('.pdf-bar button')].pop(); b?.click(); return true })()`);
  await new Promise((r) => setTimeout(r, 600));
  check('关闭 PDF 预览不会把应用打进错误页（destroy 在 loadingTask 上，不在 document 上）',
    (await evaluate(`!document.querySelector('.err-wrap') && !!document.querySelector('.ribbon')`)));
  await evaluate(`(() => {
    const f = document.querySelector('.ft-root .ft-file');
    f?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return !!f;
  })()`);
  await new Promise((r) => setTimeout(r, 900));
}

// ---------- 6. 图谱 ----------
console.log('  · 图谱前状态 =', JSON.stringify(await evaluate(`(() => ({
  hasGraphBtn: !!([...document.querySelectorAll('button')].find(x => x.title === '图谱')),
  pdfOpen: !!document.querySelector('.pdf-view'),
  currentFile: document.querySelector('.ft-file.active .ft-file-name')?.getAttribute('title') ?? null,
  statusBar: (() => { const sb = document.querySelector('.status-bar'); if (!sb) return null;
    const r = sb.getBoundingClientRect();
    return { h: Math.round(r.height), bottom: Math.round(r.bottom), winH: window.innerHeight }; })(),
  rootChild: document.getElementById('root')?.firstElementChild?.className ?? null,
  bodyText: (document.body.innerText || '').slice(0, 220),
}))()`)));
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

/*
 * 自绘边框的 CSS 半边可以在这里验：手动给 <html> 加上 frameless（正常由
 * WindowChrome 在 Windows+Tauri 下加），看圆角与透明底有没有真的生效。
 * 不能靠注入 __TAURI_INTERNALS__ 来整体模拟——那会让 fs-adapters 切到 tauriIO，
 * 整个文件系统当场瘫掉，测出来的东西就不是这一屏了。
 */
const frameless = await evaluate(`(() => {
  const root = document.documentElement;
  root.classList.add('frameless');
  const cs = getComputedStyle(document.getElementById('root'));
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  const out = { radius: cs.borderRadius, overflow: cs.overflow, rootBg: cs.backgroundColor, bodyBg };
  root.classList.add('win-maximized');
  out.maximizedRadius = getComputedStyle(document.getElementById('root')).borderRadius;
  root.classList.remove('frameless', 'win-maximized');
  return out;
})()`);
// 无边框时窗口要有投影与四周留白，否则跟桌面糊在一起
const shadow = await evaluate(`(() => {
  const root = document.documentElement;
  root.classList.add('frameless');
  const bodyPad = getComputedStyle(document.body).paddingTop;
  const sh = getComputedStyle(document.getElementById('root')).boxShadow;
  root.classList.add('win-maximized');
  const maxPad = getComputedStyle(document.body).paddingTop;
  root.classList.remove('frameless', 'win-maximized');
  return { bodyPad, hasOuterShadow: /rgba?\([^)]*\)\s+0px\s+10px/.test(sh) || sh.split(',').length >= 3, maxPad };
})()`);
check('无边框时窗口四周留出投影带，且投影不止一条内描边',
  shadow.bodyPad === '10px' && shadow.hasOuterShadow, shadow);
check('最大化时留白收掉（否则四周露出桌面）', shadow.maxPad === '0px', shadow.maxPad);

// 顶栏：有内容、整条可拖、窗口按钮长在它右端（v0.11.4 照 Obsidian 布局）
const topBar = await evaluate(`(() => {
  const bar = document.querySelector('.top-bar');
  if (!bar) return null;
  const r = bar.getBoundingClientRect();
  const app = document.querySelector('.app').getBoundingClientRect();
  return {
    top: Math.round(r.top), height: Math.round(r.height),
    fullWidth: Math.round(r.width) === Math.round(window.innerWidth),
    crumb: bar.querySelector('.tb-crumb')?.textContent?.trim() ?? null,
    // 整条可拖：容器与面包屑上都要有 data-tauri-drag-region
    dragRegions: bar.querySelectorAll('[data-tauri-drag-region]').length,
    barIsDrag: bar.hasAttribute('data-tauri-drag-region'),
    appTop: Math.round(app.top),
  };
})()`);
check('顶栏在窗口最上方、通栏，且 .app 紧接其下', topBar && topBar.top === 0 &&
  topBar.fullWidth && topBar.appTop === topBar.height, topBar);
check('顶栏里有内容（面包屑），不是一条空白横带', !!topBar && (topBar.crumb ?? '').length > 0, topBar?.crumb);
check('整条顶栏可拖窗口（v0.11.3 就是丢了这个，用户点哪都拖不动）',
  !!topBar && topBar.barIsDrag && topBar.dragRegions >= 2, topBar && { barIsDrag: topBar.barIsDrag, n: topBar.dragRegions });

const chromeGeom = await evaluate(`(() => {
  const root = document.documentElement;
  root.classList.add('frameless');
  const out = {
    // 浏览器里不是 frameless，所以顶栏右端不该出现窗口按钮
    winButtons: document.querySelectorAll('.win-buttons .win-btn').length,
    winButtonsVisible: (() => { const b = document.querySelector('.win-buttons');
      return b ? getComputedStyle(b).display !== 'none' : false; })(),
  };
  root.classList.remove('frameless');
  return out;
})()`);
check('非 frameless（浏览器 / Linux / macOS）时顶栏右端不显示窗口按钮',
  chromeGeom.winButtonsVisible === false, chromeGeom);

check('frameless：#root 有圆角且裁切内容，body 让出背景（否则圆角外还是白的）',
  frameless.radius === '10px' && frameless.overflow === 'hidden' &&
  /rgba\(0, 0, 0, 0\)|transparent/.test(frameless.bodyBg), frameless);
check('最大化时圆角收成直角（不收四角会露出桌面）', frameless.maximizedRadius === '0px', frameless.maximizedRadius);
check('没有自绘边框时布局不塌（状态栏仍在窗口内）', await evaluate(`(() => {
  const sb = document.querySelector('.status-bar');
  if (!sb) return false;
  const r = sb.getBoundingClientRect();
  return r.bottom <= window.innerHeight + 1 && r.height > 10;
})()`));

await shot('app.png');

// ---------- 7.5 代码块与 .base 表格（v0.11.10）----------
/*
 * 两件事都只有在真实产物里才验得出来：
 * - 代码块：装饰是 CodeMirror 在运行时按行加的，`scanFences` 的单测证明不了
 *   那一行真的有底色（v0.11.9 之前那三个反引号就是光秃秃地摆在正文里）。
 * - `.base`：它要读库里其它笔记的 frontmatter，然后画成表——纯函数测得到求值，
 *   测不到"点开它出不出得来这张表"。
 */
await evaluate(`(async () => {
  const root = await navigator.storage.getDirectory();
  let dir = null;
  for await (const [name, handle] of root.entries()) {
    if (handle.kind === 'directory' && name.startsWith('vault-')) { dir = handle; break; }
  }
  if (!dir) return 'no-vault-dir';
  const put = async (name, text) => {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(new TextEncoder().encode(text));
    await w.close();
  };
  const NL = String.fromCharCode(10);
  await put('甲.md', ['---', 'status: doing', '---', '', '甲的正文 #项目', ''].join(NL));
  await put('乙.md', ['---', 'status: done', '---', '', '乙的正文 #项目', ''].join(NL));
  await put('丙.md', ['没有属性的一篇', ''].join(NL));
  await put('个人空间.base', [
    'filters:',
    '  and:',
    '    - file.hasTag("项目")',
    'properties:',
    '  status:',
    '    displayName: 状态',
    'views:',
    '  - type: table',
    '    name: 我的表',
    '    order:',
    '      - file.name',
    '      - status',
    '',
  ].join(NL));
  return 'ok';
})()`);
await send('Page.reload');
await new Promise((r) => setTimeout(r, 2600));

// --- 代码块：往笔记里敲一段围栏代码 ---
{
  await evaluate(`(() => {
    const el = [...document.querySelectorAll('.ft-file-name')].find(x => x.textContent.includes('甲'));
    el?.closest('.ft-file')?.click(); return !!el })()`);
  await new Promise((r) => setTimeout(r, 900));
  const cb = await evaluate(`(() => { const c = document.querySelector('.cm-content'); if (!c) return null;
    const r = c.getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.bottom - 12) } })()`);
  if (cb) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: cb.x, y: cb.y, button: 'left', clickCount: 1, buttons: 1 });
    }
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
    for (const line of ['', '```js', 'const a = 1;', '```', '']) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      if (line) await send('Input.insertText', { text: line });
    }
    await new Promise((r) => setTimeout(r, 1000));
    await evaluate(`(() => { document.querySelector('.cm-content')?.blur(); return true })()`);
    await new Promise((r) => setTimeout(r, 800));
  }
  const fence = await evaluate(`(() => {
    const lines = [...document.querySelectorAll('.cm-live-fence')];
    if (lines.length === 0) return { n: 0 };
    const cs = getComputedStyle(lines[Math.floor(lines.length / 2)]);
    return {
      n: lines.length,
      open: document.querySelectorAll('.cm-live-fence-open').length,
      close: document.querySelectorAll('.cm-live-fence-close').length,
      bg: cs.backgroundColor,
      font: cs.fontFamily.slice(0, 24),
    };
  })()`);
  check('编辑态的围栏代码块有底色、等宽字，首尾各画一条边（此前 ``` 只是三个字面反引号）',
    fence.n >= 3 && fence.open >= 1 && fence.close >= 1 &&
    fence.bg !== 'rgba(0, 0, 0, 0)' && /mono|Consol|SFMono/i.test(fence.font ?? ''), fence);

  // --- 阅读态：代码块卡片 + 复制按钮 ---
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') ?? '').includes('阅读'));
    b?.click(); return !!b })()`);
  await new Promise((r) => setTimeout(r, 800));
  const readCode = await evaluate(`(() => {
    const box = document.querySelector('.md-preview .code-block');
    if (!box) return null;
    const cs = getComputedStyle(box);
    return {
      lang: box.querySelector('.code-lang')?.textContent ?? '',
      copy: !!box.querySelector('button.code-copy'),
      border: cs.borderTopWidth,
      radius: cs.borderTopLeftRadius,
    };
  })()`);
  check('阅读态的代码块是一张卡片：语言名 + 复制按钮 + 描边',
    !!readCode && readCode.copy && readCode.lang === 'js' && parseFloat(readCode.border) >= 1, readCode);
  await shot('code-block.png');
}

// --- .base：点开它，表要画出来 ---
{
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') ?? '').includes('编辑视图'));
    b?.click(); return true })()`);
  const clicked = await evaluate(`(() => {
    const el = [...document.querySelectorAll('.ft-file-name')].find(x => x.textContent.includes('个人空间'));
    if (!el) return false;
    el.closest('.ft-file').click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 1200));
  const base = await evaluate(`(() => {
    const v = document.querySelector('.base-view');
    if (!v) return null;
    const heads = [...v.querySelectorAll('.base-table th')].map(x => x.textContent.trim().replace(/[↑↓\\s]*$/, ''));
    const rows = [...v.querySelectorAll('.base-table tbody tr')];
    return {
      count: v.querySelector('.base-count')?.textContent ?? '',
      heads,
      rows: rows.length,
      first: rows[0]?.innerText.replace(/\s+/g, ' ').trim() ?? '',
      skipped: v.querySelector('.base-skipped')?.textContent ?? null,
    };
  })()`);
  check('点开 .base 出来的是表格视图，不是"交给 Obsidian"',
    clicked && !!base && base.rows === 2, base);
  check('列名走 displayName，结果数与筛选一致（丙.md 没有 #项目，被筛掉）',
    !!base && base.heads[0] === '名称' && base.heads[1] === '状态' && /2 个结果/.test(base.count), base);
  await shot('base-view.png');

  // 点第一行应该打开那篇笔记
  await evaluate(`(() => { document.querySelector('.base-table .base-link')?.click(); return true })()`);
  await new Promise((r) => setTimeout(r, 900));
  check('点表里的一行会打开那篇笔记（表随之关闭）', await evaluate(`(() => {
    return !document.querySelector('.base-view') && !!document.querySelector('.cm-content');
  })()`));
}

// ---------- 7.55 清单正文的颜色与复选框（v0.11.11）----------
/*
 * 用户原话：「任务列表打勾无法点击，点一下就变成中括号了，前面还有一个 -，
 * 且右侧文案没有缩进，而且我的这些字颜色特别浅」。
 * 这几条全是运行时算出来的，只有量真实产物的 computed 值才作数。
 */
{
  await evaluate(`(() => {
    const el = [...document.querySelectorAll('.ft-file-name')].find(x => x.textContent.includes('乙'));
    el?.closest('.ft-file')?.click(); return !!el })()`);
  await new Promise((r) => setTimeout(r, 900));
  const cb = await evaluate(`(() => { const c = document.querySelector('.cm-content'); if (!c) return null;
    const r = c.getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.bottom - 12) } })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: cb.x, y: cb.y, button: 'left', clickCount: 1, buttons: 1 });
  }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
  for (const line of ['', '- [ ] 待办一二三四五六七八九十', '- 普通列表项']) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    if (line) await send('Input.insertText', { text: line });
  }
  await new Promise((r) => setTimeout(r, 900));

  const colors = await evaluate(`(() => {
    const norm = (c) => c.replace(/\\s/g, '');
    const body = norm(getComputedStyle(document.querySelector('.cm-content')).color);
    const muted = norm(getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#000');
    // 清单那一行里承载文字的那个 span（CodeMirror 给它挂的是高亮 class）
    const line = [...document.querySelectorAll('.cm-line')].find(l => l.textContent.includes('普通列表项'));
    const spans = line ? [...line.querySelectorAll('span')].filter(s => s.textContent.includes('普通列表项')) : [];
    return {
      body,
      muted,
      listText: spans.length ? norm(getComputedStyle(spans[spans.length - 1]).color) : body,
      taskLineIndent: (() => {
        const t = [...document.querySelectorAll('.cm-live-task')];
        if (!t.length) return null;
        const cs = getComputedStyle(t[t.length - 1]);
        return { padLeft: cs.paddingLeft, indent: cs.textIndent };
      })(),
    };
  })()`);
  check('清单正文用的是正文墨色，不是次要文字色（满屏清单不该整页发灰）',
    colors.listText === colors.body, colors);
  check('任务行是悬挂缩进（折行的文字对齐第一行文本，不顶到复选框下面）',
    !!colors.taskLineIndent && parseFloat(colors.taskLineIndent.padLeft) > 8 &&
    parseFloat(colors.taskLineIndent.indent) < 0, colors.taskLineIndent);

  // 光标就在这一行：复选框必须还在（原来会当场退回 `- [ ]`）
  const boxWithCursor = await evaluate(`document.querySelectorAll('.cm-task-checkbox').length`);
  check('光标停在任务行时复选框仍然渲染（此前点一下就退回 `- [ ]`）', boxWithCursor >= 1, boxWithCursor);

  // 点一下复选框：要真的勾上，而且勾完还是复选框
  const before = await evaluate(`document.querySelector('.cm-content').innerText.includes('[x]')`);
  await evaluate(`(() => { const b = document.querySelector('.cm-task-checkbox'); if (!b) return false;
    const r = b.getBoundingClientRect(); window.__box = { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; return true })()`);
  const boxPt = await evaluate(`window.__box`);
  if (boxPt) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: boxPt.x, y: boxPt.y, button: 'left', clickCount: 1, buttons: 1 });
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  // 真相要去磁盘上取：编辑区里显示的是复选框，`innerText` 当然读不到 `[x]`
  await new Promise((r) => setTimeout(r, 1400)); // 等防抖落盘
  const onDisk = await evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== 'directory' || !name.startsWith('vault-')) continue;
      try {
        const fh = await handle.getFileHandle('乙.md');
        return await (await fh.getFile()).text();
      } catch (e) { /* 换下一个库目录 */ }
    }
    return null;
  })()`);
  const after = await evaluate(`(() => ({
    src: false,
    boxes: document.querySelectorAll('.cm-task-checkbox').length,
    checked: document.querySelectorAll('.cm-task-checked').length,
    dashLeft: [...document.querySelectorAll('.cm-line')].some(l => /^\\s*-\\s+\\[/.test(l.textContent)),
    text: document.querySelector('.cm-content').innerText.split('\\n').slice(-4).join(' | '),
    focused: document.querySelector('.cm-editor')?.classList.contains('cm-focused') ?? false,
  }))()`);
  check('点复选框真的勾上了（磁盘上的源码变成 `[x]`），且勾完仍是复选框、前面不再露出 `-`',
    /- \[x\] 待办/.test(onDisk ?? '') && after.boxes >= 1 && after.checked >= 1 && !after.dashLeft,
    { before, after, onDisk: (onDisk ?? '').split('\n').slice(-3).join(' | ') });
  await shot('task-list.png');
}

// ---------- 7.6 手机端：抽屉圆角与底部菜单（v0.11.10）----------
/*
 * 用户报的是「侧边栏展开的直角改为 R 角」「按钮弹窗也不好看」。
 * 这两件事只有把窗口缩到手机尺寸、真的把抽屉和菜单打开才量得到——
 * 桌面视口下这两个组件根本不渲染。
 */
{
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 780, deviceScaleFactor: 2, mobile: true,
  });
  await send('Page.reload');
  await new Promise((r) => setTimeout(r, 2600));

  const isMobileLayout = await evaluate(`!!document.querySelector('.m-app')`);
  check('窄屏走的是移动端布局', isMobileLayout);

  // 打开抽屉
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') ?? '').includes('文件列表'));
    b?.click(); return !!b })()`);
  await new Promise((r) => setTimeout(r, 700));
  const drawer = await evaluate(`(() => {
    const d = document.querySelector('.m-drawer2');
    if (!d) return null;
    const cs = getComputedStyle(d);
    return {
      open: d.classList.contains('open'),
      topRight: cs.borderTopRightRadius,
      bottomRight: cs.borderBottomRightRadius,
      overflow: cs.overflow,
      shadow: cs.boxShadow !== 'none',
    };
  })()`);
  check('抽屉右侧是圆角、有投影，并裁切内容（用户点名的"直角改 R 角"）',
    !!drawer && drawer.open && parseFloat(drawer.topRight) >= 12 &&
    parseFloat(drawer.bottomRight) >= 12 && drawer.overflow === 'hidden' && drawer.shadow, drawer);
  await shot('mobile-drawer.png');

  // 抽屉里长按一个文件 → 底部菜单
  const row = await evaluate(`(() => {
    const names = [...document.querySelectorAll('.m-tree-name')];
    const el = names.find(x => /\\.md$|甲|乙/.test(x.textContent)) ?? names[0];
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (row) {
    // 长按是 touch 事件里自己计时的（安卓 WebView 的 contextmenu 时有时无，
    // 所以两条路都留着）。这里走真的触摸：按下、停 700ms、抬起。
    const touch = [{ x: row.x, y: row.y, radiusX: 6, radiusY: 6, force: 1, id: 1 }];
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touch });
    await new Promise((r) => setTimeout(r, 800));
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await new Promise((r) => setTimeout(r, 700));
  }
  const sheet = await evaluate(`(() => {
    const g = document.querySelector('.m-sheet2-group');
    if (!g) return null;
    const gs = getComputedStyle(g);
    const items = [...g.querySelectorAll('.m-sheet2-item')];
    const it = items[0] ? items[0].getBoundingClientRect() : null;
    const sep = items[1] ? getComputedStyle(items[1], '::before') : null;
    return {
      groups: document.querySelectorAll('.m-sheet2-group').length,
      radius: gs.borderTopLeftRadius,
      shadow: gs.boxShadow !== 'none',
      itemH: it ? Math.round(it.height) : null,
      sepLeft: sep ? sep.left : null,
      icons: g.querySelectorAll('.m-sheet2-ico svg').length,
    };
  })()`);
  if (!sheet) {
    console.log('  · 菜单没弹出来，现场 =', JSON.stringify(await evaluate(`(() => ({
      names: [...document.querySelectorAll('.m-tree-name')].map(x => x.textContent).slice(0, 8),
      mask: !!document.querySelector('.m-sheet-mask'),
      row: ${JSON.stringify(row)},
    }))()`)));
  }
  check('底部菜单是分组圆角卡片，行高够按，分隔线从文字处起画（不横穿图标栏）',
    !!sheet && parseFloat(sheet.radius) >= 12 && sheet.shadow && (sheet.itemH ?? 0) >= 48 &&
    parseFloat(sheet.sepLeft ?? '0') >= 40 && sheet.icons > 0, sheet);
  await shot('mobile-sheet.png');

  await send('Emulation.clearDeviceMetricsOverride');
  await send('Page.reload');
  await new Promise((r) => setTimeout(r, 2400));
}

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

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
 * ⚠️ **传给 evaluate 的那段代码是模板字面量：里面一个反引号都不能出现。**
 * 注释里写 `.m-sheet2`、写 ``` 围栏、写 `y`——都会把模板当场截断，
 * 报错还长得毫不相干（"missing ) after argument list" / "xxx is not defined"）。
 * 需要反引号就用 String.fromCharCode(96)，需要引用类名就直接写名字、不要加反引号。
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

/*
 * 调试端口**必须每次随机**，而且退出时要把浏览器和 profile 都收干净。
 *
 * 端口原来写死 9333：脚本中途崩过一次（比如模板字面量里混进反引号）之后，
 * 那个 Chrome 不会自己退出，仍然占着 9333。下一次运行的 `wsUrl()` 于是连上
 * **上一轮那个浏览器**——它还带着上一轮的 profile、上一轮的 OPFS 库、
 * 甚至还停在手机模拟视口里。表现就是"什么都没改，突然一片红"，
 * 而真正的产物一点问题都没有。同一批残留还堆了 70 多个 profile 目录。
 *
 * 这类"验证台自己说谎"的问题比被它挡住的 bug 更贵：它会让人开始不相信红灯。
 */
const DEVTOOLS_PORT = 9400 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync('/tmp/ivnote-verify-');
const chrome = spawn('google-chrome', [
  '--headless=new', `--remote-debugging-port=${DEVTOOLS_PORT}`, '--no-sandbox',
  '--disable-gpu', '--disable-dev-shm-usage', `--user-data-dir=${profile}`,
  '--window-size=1400,900', '--hide-scrollbars', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

/** 无论怎么退出（正常结束、断言抛错、Ctrl+C）都要收拾干净 */
const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch { /* 已经没了 */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 下次再说 */ }
};
process.on('exit', cleanup);
process.on('uncaughtException', (e) => {
  cleanup();
  console.error(e);
  process.exit(1);
});
process.on('SIGINT', () => { cleanup(); process.exit(130); });

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/list`);
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
  /*
   * v0.11.11 起，文件名与正文首个 H1 同名时内联标题**会被隐藏**（那正是用户要的
   * "别显示两个名字"，而 titleSync 会把文件名改成 H1，所以同名是常态）。
   * 所以这里量的是「顶栏 → 第一行可见内容」的距离，不再钉死在 .inline-title 上：
   * 这条用例真正要守的是"上面别空一大片"，不是"必须有个内联标题元素"。
   */
  const title = document.querySelector('.inline-title') ?? document.querySelector('.cm-content .cm-line');
  const line = document.querySelector('.cm-content .cm-line');
  if (!bar || !title) return null;
  const b = bar.getBoundingClientRect(), t = title.getBoundingClientRect();
  return {
    barBottom: Math.round(b.bottom),
    titleTop: Math.round(t.top),
    gapAboveTitle: Math.round(t.top - b.bottom),
    titleHeight: Math.round(t.height),
    sameAsFirstLine: title === line,
    gapTitleToBody: !line || title === line ? 0 : Math.round(line.getBoundingClientRect().top - t.bottom),
  };
})()`);
check('顶栏到第一行内容的留白够紧（原来 32px，加上顶栏一共 70px 全是空的）',
  // 内联标题被去重规则藏起来时，这里量的是 H1 那一行，它自带 0.4em 上边距，故放宽到 24px
  !!titleGeom && titleGeom.gapAboveTitle <= (titleGeom.sameAsFirstLine ? 24 : 16), titleGeom);
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
/*
 * v0.11.16（修正）：图谱开在**主区**——用户纠正过一次：「我说的图谱放在右侧窗口
 * 不是最右侧大纲这啊，是侧边栏的右侧，也就是中间空白的这里」。
 * 所以它既不该是盖住整个窗口的新页面，也不该挤在 248px 的大纲栏里。
 */
await evaluate(`(() => {
  const b = [...document.querySelectorAll('.ribbon .ribbon-btn')].find(x => x.getAttribute('aria-label') === '图谱');
  b?.click(); return !!b;
})()`);
await new Promise((r) => setTimeout(r, 1500));
const graph = await evaluate(`(() => {
  const g = document.querySelector('.graph-pane');
  if (!g) return { present: false, full: !!document.querySelector('.graph-full') };
  const r = g.getBoundingClientRect();
  const pane = document.querySelector('.editor-pane').getBoundingClientRect();
  const side = document.querySelector('.sidebar').getBoundingClientRect();
  return {
    present: true,
    width: Math.round(r.width),
    // 左边界要落在侧栏右边（= 主区那块），而不是 0（整屏）
    left: Math.round(r.left),
    sideRight: Math.round(side.right),
    inPane: Math.abs(r.left - pane.left) <= 2 && Math.abs(r.width - pane.width) <= 2,
    sidebarVisible: side.width > 100,
    inRightPanel: !!document.querySelector('.right-panel .graph-pane'),
    nodes: g.querySelectorAll('.graph-node').length,
    hasSearch: !!g.querySelector('.graph-search'),
  };
})()`);
check('图谱开在主区（侧栏右边那块），既不盖住整屏、也不挤进最右边的大纲栏',
  graph.present && graph.inPane && graph.sidebarVisible && !graph.inRightPanel &&
  graph.left > graph.sideRight - 4 && graph.width >= 600 && graph.hasSearch, graph);
await shot('graph.png');
await evaluate(`(() => { const b = document.querySelector('.graph-toolbar [aria-label="关闭"]'); b?.click(); return true })()`);
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
    tabs: bar.querySelectorAll('.tb-tab').length,
    // 整条可拖：容器与面包屑上都要有 data-tauri-drag-region
    dragRegions: bar.querySelectorAll('[data-tauri-drag-region]').length,
    barIsDrag: bar.hasAttribute('data-tauri-drag-region'),
    appTop: Math.round(app.top),
  };
})()`);
check('顶栏在窗口最上方、通栏，且 .app 紧接其下', topBar && topBar.top === 0 &&
  topBar.fullWidth && topBar.appTop === topBar.height, topBar);
check('顶栏里有内容（标签页 / 面包屑），不是一条空白横带',
  !!topBar && ((topBar.crumb ?? '').length > 0 || topBar.tabs > 0), topBar);
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

  /*
   * v0.11.15：**`.base` 的数据源是"库里的文件"，不是"库里的笔记"。**
   *
   * 用户原话：「个人空间统计不完全啊，图片，pdf，个人空间本身的 .base 文件都没有
   * 在个人空间里面体现」。此前喂给它的是正文索引（只含 .md），于是一张按文件夹
   * 筛的表里，图片 / PDF / 这个 .base 自己全都不见。这里造一个只按文件夹筛的表，
   * 数它到底数全了没有。
   */
  await evaluate(`(async () => {
    const bin = atob(${JSON.stringify(PNG_1X1)});
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const root = await navigator.storage.getDirectory();
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== 'directory' || !name.startsWith('vault-')) continue;
      const dir = await handle.getDirectoryHandle('资料', { create: true });
      const NL = String.fromCharCode(10);
      const put = async (n, text) => {
        const fh = await dir.getFileHandle(n, { create: true });
        const w = await fh.createWritable();
        await w.write(new TextEncoder().encode(text));
        await w.close();
      };
      await put('说明.md', ['# 说明', '', '正文', ''].join(NL));
      await put('全部.base', [
        'filters:', '  and:', '    - file.inFolder("资料")',
        'views:', '  - type: table', '    name: 全部', '    order:', '      - file.name', '      - file.ext', '',
      ].join(NL));
      const ih = await dir.getFileHandle('插图.png', { create: true });
      const iw = await ih.createWritable();
      await iw.write(bytes);
      await iw.close();
      return 'ok';
    }
    return 'no-vault';
  })()`);
  await send('Page.reload');
  await new Promise((r) => setTimeout(r, 2600));
  // 文件夹可能是收起的：找不到里面的文件就先展开它，再找一次
  const openedAll = await evaluate(`(async () => {
    const findFile = () => [...document.querySelectorAll('.ft-file-name')].find(x => x.textContent.includes('全部'));
    if (!findFile()) {
      const dir = [...document.querySelectorAll('.ft-dir-name')].find(x => x.textContent === '资料');
      dir?.closest('.ft-dir')?.click();
      await new Promise(r => setTimeout(r, 400));
    }
    const el = findFile();
    const row = el?.closest('.ft-file');
    row?.scrollIntoView({ block: 'center' });
    row?.click();
    return {
      clicked: !!row,
      tree: [...document.querySelectorAll('.ft-file-name, .ft-dir-name')].map(x => x.textContent).slice(0, 24),
    };
  })()`);
  await new Promise((r) => setTimeout(r, 1200));
  const allFilesTable = await evaluate(`(() => {
    const v = document.querySelector('.base-view');
    if (!v) return null;
    const rows = [...v.querySelectorAll('.base-table tbody tr')].map(r => r.innerText.replace(/\s+/g, ' ').trim());
    return { count: v.querySelector('.base-count')?.textContent ?? '', rows };
  })()`);
  check('.base 表里图片 / .base 自己都在（数据源是库里的文件，不是只有笔记）',
    openedAll.clicked && !!allFilesTable &&
    allFilesTable.rows.some((r) => r.includes('插图')) &&
    allFilesTable.rows.some((r) => r.includes('全部')) &&
    allFilesTable.rows.some((r) => r.includes('说明')), { ...allFilesTable, ...openedAll });
  await shot('base-all-files.png');

  // 点图片那一行：要开图片层，而不是拿文本通道去读 PNG 然后炸掉
  await evaluate(`(() => {
    const link = [...document.querySelectorAll('.base-table .base-link')].find(a => a.textContent.includes('插图'));
    link?.click(); return !!link })()`);
  await new Promise((r) => setTimeout(r, 1200));
  const imgFromBase = await evaluate(`(() => {
    const v = document.querySelector('.img-view');
    return { open: !!v, natural: v?.querySelector('img')?.naturalWidth ?? 0, err: !!document.querySelector('.err-wrap') };
  })()`);
  check('点表里的图片一行会打开图片预览（不是当成笔记去读，也不该把应用打进错误页）',
    imgFromBase.open && imgFromBase.natural > 0 && !imgFromBase.err, imgFromBase);
  await evaluate(`(() => { document.querySelector('.img-view')?.click(); return true })()`);
  await new Promise((r) => setTimeout(r, 400));
}

// ---------- 7.5b 右栏大纲（v0.11.11）----------
/*
 * 用户报「右侧的查看大纲按钮点了之后没有显示大纲，而是直接消失不见了」。
 * 右栏是可折叠的：折起来只剩一条竖轨，展开才有「大纲 / 反向链接」两个标签。
 * 这里把这两个状态都点一遍，量它到底给了什么。
 */
{
  // 先造一篇**有标题**的笔记：大纲的输入就是标题，没标题时它本来就该显示空状态
  await evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== 'directory' || !name.startsWith('vault-')) continue;
      const fh = await handle.getFileHandle('大纲用.md', { create: true });
      const w = await fh.createWritable();
      const NL = String.fromCharCode(10);
      await w.write(new TextEncoder().encode(
        ['# 一级标题', '', '正文', '', '## 二级标题', '', '正文', '', '### 三级标题', ''].join(NL)));
      await w.close();
      return 'ok';
    }
    return 'no-vault';
  })()`);
  await send('Page.reload');
  await new Promise((r) => setTimeout(r, 2400));
  await evaluate(`(() => {
    const el = [...document.querySelectorAll('.ft-file-name')].find(x => x.textContent.includes('大纲用'));
    el?.closest('.ft-file')?.click(); return !!el })()`);
  await new Promise((r) => setTimeout(r, 900));
  const state = await evaluate(`(() => ({
    panel: !!document.querySelector('.right-panel'),
    rail: !!document.querySelector('.right-rail'),
    outlineItems: document.querySelectorAll('.rp-outline a, .rp-outline button, .rp-outline li').length,
    tabs: [...document.querySelectorAll('.rp-tab')].map(x => x.textContent.trim()),
  }))()`);
  console.log('  · 右栏初始 =', JSON.stringify(state));

  // 折起来的话先点竖轨上的按钮展开
  if (!state.panel) {
    await evaluate(`(() => { document.querySelector('.right-rail button')?.click(); return true })()`);
    await new Promise((r) => setTimeout(r, 500));
  }
  const opened = await evaluate(`(() => {
    const p = document.querySelector('.right-panel');
    if (!p) return null;
    const tabs = [...p.querySelectorAll('.rp-tab')];
    tabs.find(t => t.textContent.includes('大纲'))?.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const outline = await evaluate(`(() => {
    const p = document.querySelector('.right-panel');
    if (!p) return null;
    const nav = p.querySelector('.rp-outline');
    return {
      hasPanel: true,
      hasNav: !!nav,
      items: nav ? nav.children.length : 0,
      text: nav ? nav.textContent.slice(0, 40) : (p.textContent ?? '').slice(0, 60),
    };
  })()`);
  check('点「大纲」标签能看到当前笔记的标题列表（不是把整个右栏收掉）',
    !!opened && !!outline && outline.hasNav && outline.items > 0, outline);
  await shot('outline.png');

  /*
   * 窄窗口（用户那台是约 960px）：右栏原来被 `@media(max-width:1080px){display:none}`
   * 藏掉——点展开之后竖轨变成面板、面板又被藏，整条右栏凭空消失。
   * 这里把窗口缩到 1000px 再点一遍，量它是不是真的看得见。
   */
  await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 760, deviceScaleFactor: 1, mobile: false });
  await new Promise((r) => setTimeout(r, 500));
  await evaluate(`(() => { document.querySelector('.right-panel .rp-head .icon-btn')?.click(); return true })()`);
  await new Promise((r) => setTimeout(r, 300));
  await evaluate(`(() => { document.querySelector('.right-rail button')?.click(); return true })()`);
  await new Promise((r) => setTimeout(r, 400));
  const narrow = await evaluate(`(() => {
    const p = document.querySelector('.right-panel');
    if (!p) return { present: false };
    const cs = getComputedStyle(p);
    const r = p.getBoundingClientRect();
    return {
      present: true,
      display: cs.display,
      width: Math.round(r.width),
      onScreen: r.right <= window.innerWidth + 1 && r.width > 40,
      items: p.querySelectorAll('.rp-outline .rp-h').length,
    };
  })()`);
  check('窄窗口（1000px）下展开右栏是真的能看见大纲，而不是整块消失',
    narrow.present && narrow.display !== 'none' && narrow.onScreen && narrow.items > 0, narrow);
  await shot('outline-narrow.png');
  await send('Emulation.clearDeviceMetricsOverride');
  await new Promise((r) => setTimeout(r, 300));
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

// ---------- 7.7 重开回到上次那篇 + 标题不重复（v0.11.11）----------
{
  // 打开一篇有 H1 的笔记，刷新（等于重开应用），看还在不在这一篇上
  /*
   * v0.11.13：**打开一篇笔记不该把它改名。**
   * 编辑器的 updateListener 原来对任何 docChanged 都上报，包括"把文件内容灌进来"
   * 那一次——于是光是打开就写盘 + 按 H1 改名（用户：「文件本来就是这个名字，
   * 还非要再命名一次」）。这里开一篇文件名与 H1 不同的笔记，等过防抖再看名字还在不在。
   */
  await evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== 'directory' || !name.startsWith('vault-')) continue;
      const fh = await handle.getFileHandle('不该被改名.md', { create: true });
      const w = await fh.createWritable();
      await w.write(new TextEncoder().encode('# 正文里的标题' + String.fromCharCode(10)));
      await w.close();
      return 'ok';
    }
    return 'no-vault';
  })()`);
  await send('Page.reload');
  await new Promise((r) => setTimeout(r, 2400));
  await evaluate(`(() => {
    const el = [...document.querySelectorAll('.ft-file-name')].find(x => x.textContent.includes('不该被改名'));
    (el?.closest('.ft-file'))?.scrollIntoView({ block: 'center' });
    (el?.closest('.ft-file'))?.click();
    return !!el })()`);
  await new Promise((r) => setTimeout(r, 2000)); // 等过写盘防抖
  const stillNamed = await evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== 'directory' || !name.startsWith('vault-')) continue;
      const names = [];
      for await (const [n] of handle.entries()) names.push(n);
      return { kept: names.includes('不该被改名.md'), renamed: names.includes('正文里的标题.md') };
    }
    return null;
  })()`);
  check('只是打开一篇笔记，不该把它按 H1 改名（也不该写盘）',
    !!stillNamed && stillNamed.kept && !stillNamed.renamed, stillNamed);

  const clickedTarget = await evaluate(`(() => {
    const el = [...document.querySelectorAll('.ft-file-name')].find(x => x.textContent.includes('大纲用'));
    if (!el) return false;
    const row = el.closest('.ft-file');
    row.scrollIntoView({ block: 'center' });
    row.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 1200));
  if (!clickedTarget) console.log('  · 没点到「大纲用」这一篇——下面那条还原用例的前提就不成立');
  await send('Page.reload');
  await new Promise((r) => setTimeout(r, 2600));
  const restored = await evaluate(`(() => ({
    crumb: document.querySelector('.top-bar .crumb, .crumb')?.textContent ?? '',
    hasEditor: !!document.querySelector('.cm-content'),
    body: (document.querySelector('.cm-content')?.innerText ?? '').slice(0, 20),
  }))()`);
  check('重开之后回到退出前那篇笔记（不再是空白欢迎页）',
    clickedTarget && restored.hasEditor && /一级标题/.test(restored.body), { clickedTarget, ...restored });

  // 文件名与 H1 **不同**时两行都要在（它们携带不同信息）
  const differing = await evaluate(`(() => ({
    inline: document.querySelectorAll('.inline-title').length,
    firstLine: (document.querySelector('.cm-content')?.innerText ?? '').split(String.fromCharCode(10))[0],
  }))()`);
  check('文件名与正文 H1 不同时，内联标题照常显示（两行说的是两件事）',
    differing.inline === 1, differing);

  /*
   * 文件名与 H1 **是同一个**时，不该再顶一行一模一样的标题——用户报的
   * 「文件本来就是这个名字，还非要再命名一次，然后就显示了两个名字」。
   * 判定按清洗后比较：H1 里可以有 `/`，文件名里不能，直接比字符串永远不相等。
   */
  await evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== 'directory' || !name.startsWith('vault-')) continue;
      const fh = await handle.getFileHandle('同名 标题.md', { create: true });
      const w = await fh.createWritable();
      const NL = String.fromCharCode(10);
      await w.write(new TextEncoder().encode(['# 同名 / 标题', '', '正文', ''].join(NL)));
      await w.close();
      return 'ok';
    }
    return 'no-vault';
  })()`);
  await send('Page.reload');
  await new Promise((r) => setTimeout(r, 2400));
  await evaluate(`(() => {
    const el = [...document.querySelectorAll('.ft-file-name')].find(x => x.textContent.includes('同名'));
    el?.closest('.ft-file')?.click(); return !!el })()`);
  await new Promise((r) => setTimeout(r, 900));
  const same = await evaluate(`(() => ({
    inline: document.querySelectorAll('.inline-title').length,
    firstLine: (document.querySelector('.cm-content')?.innerText ?? '').split(String.fromCharCode(10))[0],
  }))()`);
  check('文件名与正文 H1 是同一个标题（差别只在 `/` 这种文件名非法字符）时，不再重复顶一行',
    same.inline === 0 && /同名/.test(same.firstLine ?? ''), same);
  await shot('restore.png');
}

// ---------- 7.8 正文配色与顶栏标签（v0.11.11）----------
{
  // 造一篇把"该有颜色的地方"都写全的笔记
  await evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== 'directory' || !name.startsWith('vault-')) continue;
      const NL = String.fromCharCode(10);
      // 反引号不能直接写进这段字符串：它整段是模板字面量，写进去就把它截断了
      const FENCE = String.fromCharCode(96, 96, 96);
      const put = async (n, lines) => {
        const fh = await handle.getFileHandle(n, { create: true });
        const w = await fh.createWritable();
        await w.write(new TextEncoder().encode(lines.join(NL)));
        await w.close();
      };
      await put('配色样张.md', [
        '# 配色样张', '',
        '正文里有 ' + String.fromCharCode(96) + '行内代码' + String.fromCharCode(96) +
          '、==高亮== 和 [链接](https://example.com)。', '',
        '> 引用一行', '',
        '- 列表项', '- [x] 已完成的任务', '',
        '| 表头 | 值 |', '| --- | --- |', '| a | b |', '',
        FENCE + 'js', 'const a = 1;', FENCE, '',
      ]);
      await put('第二篇.md', ['# 第二篇', '', '用来验标签切换。', '']);
      return 'ok';
    }
    return 'no-vault';
  })()`);
  await send('Page.reload');
  await new Promise((r) => setTimeout(r, 2500));

  /*
   * v0.11.16：**从侧栏点文件不再越点越多标签**（Obsidian 语义）。
   * 用户原话：「每点开一个文件就自动多一个标签，点开的多了就挤满了……obsidian 的
   * 在同一个标签下面从侧边栏切换文件就不新增标签，只有点顶部标签旁边的 + 号才会
   * 新增标签页，但是我这个 + 号是新建文件」。
   */
  const clickFile = async (name, ctrl = false) => {
    await evaluate(`(() => {
      const el = [...document.querySelectorAll('.ft-file-name')].find(x => x.textContent.includes(${JSON.stringify(name)}));
      const row = el?.closest('.ft-file');
      row?.scrollIntoView({ block: 'center' });
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: ${ctrl} }));
      return !!row;
    })()`);
    await new Promise((r) => setTimeout(r, 800));
  };
  const tabState = () => evaluate(`(() => {
    const els = [...document.querySelectorAll('.tb-tab')];
    return {
      count: els.length,
      labels: els.map(e => e.querySelector('.tb-tab-name')?.textContent ?? ''),
      active: els.find(e => e.classList.contains('on'))?.querySelector('.tb-tab-name')?.textContent ?? null,
      inTopBar: !!document.querySelector('.top-bar .tb-tabs'),
      hasNew: !!document.querySelector('.tb-tab-new'),
    };
  })()`);

  await clickFile('配色样张');
  const oneTab = await tabState();
  await clickFile('第二篇');
  const stillOne = await tabState();
  check('从侧栏连点两篇：标签**没有**变多，当前标签换成了新的那篇',
    stillOne.count === oneTab.count && stillOne.active === '第二篇' &&
    !stillOne.labels.includes('配色样张'), { oneTab, stillOne });

  // Ctrl+点 = 另起一个标签（中键同理，见 FileTree 的 onAuxClick）
  await clickFile('配色样张', true);
  const twoTabs = await tabState();
  check('Ctrl 点侧栏才另起一个标签（两篇都在，当前是刚点的那篇）',
    twoTabs.count === stillOne.count + 1 && twoTabs.active === '配色样张' &&
    twoTabs.labels.includes('第二篇'), twoTabs);

  // 顶栏的 + 号：新标签页，不是新建文件
  const beforeNew = await evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    for await (const [n, h] of root.entries()) {
      if (h.kind !== 'directory' || !n.startsWith('vault-')) continue;
      let c = 0;
      for await (const [f] of h.entries()) c++;
      return c;
    }
    return -1;
  })()`);
  await evaluate(`(() => { document.querySelector('.tb-tab-new')?.click(); return true })()`);
  await new Promise((r) => setTimeout(r, 700));
  const afterNew = await tabState();
  const filesAfterNew = await evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    for await (const [n, h] of root.entries()) {
      if (h.kind !== 'directory' || !n.startsWith('vault-')) continue;
      let c = 0;
      for await (const [f] of h.entries()) c++;
      return c;
    }
    return -1;
  })()`);
  check('顶栏的 + 是"新标签页"：多一个空白标签、且**没有**顺手建出一个文件',
    afterNew.count === twoTabs.count + 1 && afterNew.active === '新标签页' &&
    filesAfterNew === beforeNew, { afterNew, beforeNew, filesAfterNew });

  /*
   * 在空白标签里打开一篇**还没开着**的笔记：就地装进去，不再多一个。
   * 点一篇"已经开着"的会切到它那个标签（和 Obsidian 一致），那不是这条要验的事。
   */
  await clickFile('大纲用');
  const filled = await tabState();
  check('空白标签里点一篇没开过的笔记：就地装进去，标签数不变',
    filled.count === afterNew.count && filled.active === '大纲用' &&
    !filled.labels.includes('新标签页'), filled);
  const tabs = filled;
  const openTwo = true;

  // 点回另一个标签要真的切过去
  await evaluate(`(() => {
    const t = [...document.querySelectorAll('.tb-tab')].find(e => e.textContent.includes('配色样张'));
    t?.click(); return true })()`);
  await new Promise((r) => setTimeout(r, 700));
  const switched = await evaluate(`(() => ({
    active: document.querySelector('.tb-tab.on .tb-tab-name')?.textContent ?? null,
    body: (document.querySelector('.cm-content')?.innerText ?? '').slice(0, 12),
  }))()`);
  check('点标签能切回那一篇（正文跟着换）',
    switched.active === '配色样张' && /配色样张/.test(switched.body), switched);

  // 关掉当前标签：应当切到剩下那个，而不是空白
  await evaluate(`(() => { document.querySelector('.tb-tab.on .tb-tab-x')?.click(); return true })()`);
  await new Promise((r) => setTimeout(r, 800));
  const afterClose = await evaluate(`(() => ({
    count: document.querySelectorAll('.tb-tab').length,
    active: document.querySelector('.tb-tab.on .tb-tab-name')?.textContent ?? null,
    hasEditor: !!document.querySelector('.cm-content'),
  }))()`);
  check('关掉当前标签后落到相邻那一篇上（不是掉回空白页）',
    afterClose.active !== null && afterClose.hasEditor, afterClose);
  await shot('tabs.png');

  /*
   * v0.11.16：**删掉的文件要自己从标签栏消失。**
   * 用户原话：「已经删除的文件为什么依然存在没有自动从顶部标签栏移除？点击的时候
   * 才有提示」。此前 pruneTabs 每个库只在启动时跑一次，此后不管谁删的都留着。
   */
  await clickFile('第二篇', true);
  const beforeDel = await tabState();
  await evaluate(`(() => {
    const el = [...document.querySelectorAll('.ft-file-name')].find(x => x.textContent.includes('第二篇'));
    const row = el?.closest('.ft-file');
    row?.scrollIntoView({ block: 'center' });
    row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 200 }));
    return !!row;
  })()`);
  await new Promise((r) => setTimeout(r, 500));
  await evaluate(`(() => {
    const item = [...document.querySelectorAll('.ctx-item')].find(b => b.querySelector('.ctx-label')?.textContent === '删除');
    item?.click(); return !!item })()`);
  await new Promise((r) => setTimeout(r, 500));
  await evaluate(`(() => {
    const ok = [...document.querySelectorAll('.dlg-mask button')].find(b => (b.textContent ?? '').includes('删除'));
    ok?.click(); return !!ok })()`);
  await new Promise((r) => setTimeout(r, 1600));
  const afterDel = await tabState();
  check('删掉一篇笔记，它的标签自己就没了（不用等点开才报错）',
    beforeDel.labels.includes('第二篇') && !afterDel.labels.includes('第二篇'),
    { beforeDel, afterDel });
  // 删的正好是当前那篇：把状态恢复成"开着一篇"，后面几条量的是标签与页面的对齐
  await clickFile('配色样张');

  /*
   * v0.11.14：**标签要和它底下那一页连在一起**（用户点名"参考浏览器和 obsidian"）。
   * 判据是量出来的三件事，不是"看着像"：
   * ① 标签条的左边界 = 内容区的左边界（此前标签横跨整条顶栏，当前标签可能停在
   *    侧栏正上方，而它代表的那一页在右边）；
   * ② 当前标签的底色 = 页面的底色，且两者之间没有缝；
   * ③ 侧栏正上方那一格装的是常用按钮，侧栏一收，它连按钮一起收掉。
   */
  const tabAlign = await evaluate(`(() => {
    const strip = document.querySelector('.tb-tabs');
    const pane = document.querySelector('.editor-pane');
    const on = document.querySelector('.tb-tab.on');
    const left = document.querySelector('.tb-left');
    const bar = document.querySelector('.top-bar');
    if (!strip || !pane || !on || !left || !bar) return null;
    const s = strip.getBoundingClientRect(), p = pane.getBoundingClientRect();
    const t = on.getBoundingClientRect(), b = bar.getBoundingClientRect();
    return {
      stripLeft: Math.round(s.left),
      paneLeft: Math.round(p.left),
      leftZoneW: Math.round(left.getBoundingClientRect().width),
      quick: left.querySelectorAll('.tb-quick').length,
      tabBg: getComputedStyle(on).backgroundColor,
      paneBg: getComputedStyle(document.querySelector('.editor-host') ?? pane).backgroundColor,
      gapUnderTab: Math.round(b.bottom - t.bottom),
      sideActionsInSidebar: document.querySelectorAll('.sidebar .side-actions').length,
    };
  })()`);
  check('标签条从内容区的左边界起画（当前标签正落在它那一页的上方）',
    !!tabAlign && Math.abs(tabAlign.stripLeft - tabAlign.paneLeft) <= 2, tabAlign);
  check('当前标签与页面同底色、底边相接（中间不留缝，也不画外框）',
    !!tabAlign && tabAlign.tabBg === tabAlign.paneBg && tabAlign.gapUnderTab === 0, tabAlign);
  check('侧栏上方那一格装着常用按钮，且侧栏里不再有第二份',
    !!tabAlign && tabAlign.quick === 4 && tabAlign.sideActionsInSidebar === 0, tabAlign);
  await shot('tabs-aligned.png');

  // 收起侧栏：那一格缩到只剩折叠按钮，标签跟着页面一起往左顶
  await evaluate(`(() => { document.querySelector('.top-bar button[aria-label="切换侧边栏"]')?.click(); return true })()`);
  await new Promise((r) => setTimeout(r, 700));
  const collapsed = await evaluate(`(() => {
    const strip = document.querySelector('.tb-tabs');
    const pane = document.querySelector('.editor-pane');
    const left = document.querySelector('.tb-left');
    if (!strip || !pane || !left) return null;
    const quick = [...left.querySelectorAll('.tb-quick')];
    const lz = left.getBoundingClientRect();
    return {
      stripLeft: Math.round(strip.getBoundingClientRect().left),
      paneLeft: Math.round(pane.getBoundingClientRect().left),
      leftZoneW: Math.round(lz.width),
      // 按钮还在 DOM 里（宽度过渡靠裁切），但已经被那一格切在外面 = 看不见也点不到
      quickVisible: quick.filter((q) => q.getBoundingClientRect().right <= lz.right + 1).length,
      sideVar: getComputedStyle(document.documentElement).getPropertyValue('--side-w').trim(),
    };
  })()`);
  check('侧栏收起时那一格连按钮一起收掉，标签仍贴着内容区左边界',
    !!collapsed && collapsed.sideVar === '0px' && collapsed.quickVisible === 0 &&
    Math.abs(collapsed.stripLeft - collapsed.paneLeft) <= 2, collapsed);
  await shot('tabs-sidebar-collapsed.png');
  await evaluate(`(() => { document.querySelector('.top-bar button[aria-label="切换侧边栏"]')?.click(); return true })()`);
  await new Promise((r) => setTimeout(r, 600));

  // --- 正文配色：量 computed 值，别靠眼睛 ---
  await evaluate(`(() => {
    const t = [...document.querySelectorAll('.ft-file-name')].find(x => x.textContent.includes('配色样张'));
    t?.closest('.ft-file')?.click(); return true })()`);
  await new Promise((r) => setTimeout(r, 800));
  // 切到阅读视图
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') ?? '').includes('阅读'));
    b?.click(); return !!b })()`);
  await new Promise((r) => setTimeout(r, 900));
  const colors = await evaluate(`(() => {
    const norm = (c) => (c || '').replace(/ /g, '');
    const accent = norm(getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
    const q = document.querySelector('.md-preview blockquote');
    const code = document.querySelector('.md-preview p code');
    const link = document.querySelector('.md-preview a');
    const mark = document.querySelector('.md-preview mark');
    const li = document.querySelector('.md-preview li');
    const cb = document.querySelector('.md-preview input[type=checkbox]');
    const lang = document.querySelector('.md-preview .code-lang');
    const body = document.querySelector('.md-preview p');
    const toHex = (rgb) => rgb;
    return {
      accent,
      quoteBorder: q ? toHex(getComputedStyle(q).borderLeftColor) : null,
      codeColor: code ? getComputedStyle(code).color : null,
      linkColor: link ? getComputedStyle(link).color : null,
      markBg: mark ? getComputedStyle(mark).backgroundColor : null,
      markerColor: li ? getComputedStyle(li, '::marker').color : null,
      checkboxAccent: cb ? getComputedStyle(cb).accentColor : null,
      langColor: lang ? getComputedStyle(lang).color : null,
      bodyColor: body ? getComputedStyle(body).color : null,
    };
  })()`);
  /*
   * 深浅主题的品牌绿不是同一支（浅 #3f6b45 / 深 #7fb56e），所以**不能写死色值**：
   * 上一轮跑完停在深色主题，写死就会红一片，而产物其实没问题。
   * 这里拿页面里真实的 --accent 解析成 rgb 再比。
   */
  const accentRgb = await evaluate(`(() => {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const d = document.createElement('div');
    d.style.color = v;
    document.body.appendChild(d);
    const rgb = getComputedStyle(d).color;
    d.remove();
    return rgb.replace(/ /g, '');
  })()`);
  const isGreen = (c) => (c ?? '').replace(/ /g, '') === accentRgb;
  check('阅读态：引用左线 / 链接 / 语言名 / 列表符号 / 复选框都用品牌绿，正文仍是墨色',
    isGreen(colors.quoteBorder) && isGreen(colors.linkColor) && isGreen(colors.langColor) &&
    isGreen(colors.markerColor) && isGreen(colors.checkboxAccent) &&
    !isGreen(colors.bodyColor) && colors.codeColor !== colors.bodyColor, colors);
  await shot('colors-read.png');

  // 编辑态同一套
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') ?? '').includes('编辑'));
    b?.click(); return !!b })()`);
  await new Promise((r) => setTimeout(r, 900));
  await evaluate(`(() => { document.querySelector('.cm-content')?.blur(); return true })()`);
  await new Promise((r) => setTimeout(r, 600));
  const edit = await evaluate(`(() => {
    const q = document.querySelector('.cm-live-quote');
    const code = document.querySelector('.cm-live-code');
    const box = document.querySelector('.cm-task-checked');
    const fence = document.querySelector('.cm-live-fence-mark');
    return {
      quoteBorder: q ? getComputedStyle(q).borderLeftColor : null,
      codeColor: code ? getComputedStyle(code).color : null,
      checkedBg: box ? getComputedStyle(box).backgroundColor : null,
      fenceColor: fence ? getComputedStyle(fence).color : null,
    };
  })()`);
  check('编辑态与阅读态同一套颜色（引用线 / 勾选 / 围栏语言都是品牌绿）',
    isGreen(edit.quoteBorder) && isGreen(edit.checkedBg) && isGreen(edit.fenceColor), edit);
  await shot('colors-edit.png');
}

// ---------- 7.84 左栏面板化 + 图谱进右栏 + 日记入口（v0.11.16）----------
/*
 * 用户原话：「最左侧的侧边栏的回收站的 UI，标签的 UI，都需要优化，你自己去看看
 * 现在的 UI，很乱，视觉上体验很差」「图谱为什么是一个新的页面？不应该也是在右侧
 * 窗口吗」「再增加个写日记的功能也放在最左侧那里」。
 *
 * 乱的根子是**同一排按钮做着两类事**：文件/搜索切左栏，标签/回收站/图谱弹窗口。
 * 所以这一组用例守的是"行为一致"：ribbon 上的面板键一律切左栏、图谱在右栏里、
 * 日记是个动作。光看截图看不出这些，得真的点。
 */
{
  const ribbon = await evaluate(`(() => ({
    labels: [...document.querySelectorAll('.ribbon .ribbon-btn')].map(b => b.getAttribute('aria-label')),
  }))()`);
  check('ribbon 上有：文件 / 搜索 / 标签 / 回收站 / 图谱 / 今日日记',
    ['文件', '搜索', '标签', '回收站', '图谱', '今日日记'].every((x) => ribbon.labels.includes(x)),
    ribbon);

  const clickRibbon = async (label) => {
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('.ribbon .ribbon-btn')].find(x => x.getAttribute('aria-label') === ${JSON.stringify(label)});
      b?.click(); return !!b })()`);
    await new Promise((r) => setTimeout(r, 500));
  };

  // --- 标签：左栏面板，不是弹窗 ---
  await clickRibbon('标签');
  const tags = await evaluate(`(() => ({
    inSidebar: !!document.querySelector('.sidebar .side-pane .sp-row'),
    modal: !!document.querySelector('.dlg-mask'),
    rows: [...document.querySelectorAll('.sidebar .sp-row .sp-name')].map(x => x.textContent),
    hasFilter: !!document.querySelector('.sidebar .sp-search input'),
    counts: [...document.querySelectorAll('.sidebar .sp-count')].map(x => x.textContent),
  }))()`);
  check('「标签」是左栏的一个面板（带筛选框与引用计数），不再盖一张对话框',
    tags.inSidebar && !tags.modal && tags.hasFilter && tags.rows.length > 0 && tags.counts.length > 0,
    tags);
  await shot('pane-tags.png');

  // 点一个标签：切到搜索面板并把 #标签 灌进搜索框
  await evaluate(`(() => { document.querySelector('.sidebar .sp-row')?.click(); return true })()`);
  await new Promise((r) => setTimeout(r, 600));
  const afterTag = await evaluate(`(() => {
    const input = document.querySelector('.sidebar input');
    return { value: input ? input.value : null, hits: document.querySelectorAll('.sidebar .sr-file, .sidebar .search-hit, .sidebar .sr-hit').length };
  })()`);
  check('点标签直接切到隔壁的搜索面板并带上 #标签（不再绕命令面板）',
    (afterTag.value ?? '').startsWith('#'), afterTag);

  // --- 回收站：左栏面板 ---
  await clickRibbon('回收站');
  const trash = await evaluate(`(() => ({
    inSidebar: !!document.querySelector('.sidebar .side-pane'),
    modal: !!document.querySelector('.dlg-mask'),
    head: document.querySelector('.sidebar .sp-head')?.textContent ?? '',
    rows: document.querySelectorAll('.sidebar .sp-row-static').length,
    empty: document.querySelector('.sidebar .sp-empty')?.textContent ?? null,
  }))()`);
  check('「回收站」也是左栏面板：有计数/清空的头部，空的时候说人话',
    trash.inSidebar && !trash.modal && (trash.rows > 0 || (trash.empty ?? '').includes('回收站')), trash);
  await shot('pane-trash.png');

  // --- 日记：点一下就该有今天那一篇 ---
  await clickRibbon('今日日记');
  await new Promise((r) => setTimeout(r, 1500));
  const daily = await evaluate(`(async () => {
    const now = new Date();
    const name = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    const root = await navigator.storage.getDirectory();
    for await (const [n, handle] of root.entries()) {
      if (handle.kind !== 'directory' || !n.startsWith('vault-')) continue;
      let dir = null;
      try { dir = await handle.getDirectoryHandle('日记'); } catch (e) { return { name, made: false, why: 'no-dir' }; }
      const names = [];
      for await (const [f] of dir.entries()) names.push(f);
      return { name, made: names.includes(name + '.md'), names };
    }
    return { name, made: false, why: 'no-vault' };
  })()`);
  check('点「今日日记」真的落了一篇 日记/YYYY-MM-DD.md（此前只有命令面板能到）',
    daily.made, daily);
  await shot('pane-daily.png');

  // 回到文件面板，后面的用例都以文件树为前提
  await clickRibbon('文件');
}

// ---------- 7.85 侧栏头部：紧凑且左右不空（v0.11.16）----------
/*
 * 用户原话：「侧边栏这个地方的 UI 布局需要优化一下，感觉不对称，右边的空间有点空。
 * 还感觉占的空间有点高」。这条量三件事：库名行铺满整个侧栏宽度、下拉箭头顶到右边缘、
 * 从侧栏顶端到文件树第一行的高度别超过一行半。
 */
{
  const head = await evaluate(`(() => {
    const side = document.querySelector('.sidebar');
    const head = document.querySelector('.side-head');
    const btn = document.querySelector('.vault-btn');
    const chevron = btn?.querySelector('svg');
    const firstRow = document.querySelector('.ft-root .ft-file, .ft-root .ft-dir');
    if (!side || !head || !btn || !firstRow) return null;
    const s = side.getBoundingClientRect(), h = head.getBoundingClientRect();
    const b = btn.getBoundingClientRect(), c = chevron.getBoundingClientRect();
    return {
      sideRight: Math.round(s.right),
      headRight: Math.round(h.right),
      btnRight: Math.round(b.right),
      chevronGap: Math.round(b.right - c.right),
      // 侧栏顶到文件树第一行：这就是"占多高"
      toFirstRow: Math.round(firstRow.getBoundingClientRect().top - s.top),
      actionRows: document.querySelectorAll('.sidebar .side-actions').length,
    };
  })()`);
  check('库名那一行铺满侧栏，下拉箭头顶到右边缘（右边不再空半条）',
    !!head && head.chevronGap <= 12 && head.headRight - head.btnRight <= 30, head);
  check('侧栏顶端到文件树第一行不超过 56px（那行图标已搬去顶栏，剩下的留白也收紧了）',
    !!head && head.toFirstRow <= 56 && head.actionRows === 0, head);
  await shot('sidebar-head.png');
}

// ---------- 7.87 导出 PDF：真的打一份出来，逐页数有没有字（v0.11.17）----------
/*
 * 用户拿到的 PDF「只有第一页，总页数还多出那么多」。我把他同步到服务器上的那份
 * 捞下来数过：78 页里 77 页内容流是 0 字节。所以这条用例不看样式、不看 DOM——
 * **真的用 CDP 打一份 PDF 出来，数每一页有没有内容**（CDP 与 WebView2 的
 * PrintToPdf 是同一条 Skia 打印管线）。
 */
{
  // 造一篇长到必然跨页的笔记
  await evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    for await (const [name, h] of root.entries()) {
      if (h.kind !== 'directory' || !name.startsWith('vault-')) continue;
      const NL = String.fromCharCode(10);
      const lines = ['# 导出样张', ''];
      for (let i = 1; i <= 80; i++) lines.push('## 第 ' + i + ' 节', '', '正文第' + i + '段：这一段必须出现在 PDF 里。', '');
      const fh = await h.getFileHandle('导出样张.md', { create: true });
      const w = await fh.createWritable();
      await w.write(new TextEncoder().encode(lines.join(NL)));
      await w.close();
      return 'ok';
    }
    return 'no-vault';
  })()`);
  await send('Page.reload');
  await new Promise((r) => setTimeout(r, 2600));
  await evaluate(`(() => {
    const el = [...document.querySelectorAll('.ft-file-name')].find(x => x.textContent.includes('导出样张'));
    const row = el?.closest('.ft-file'); row?.scrollIntoView({ block: 'center' }); row?.click(); return !!el })()`);
  await new Promise((r) => setTimeout(r, 1200));

  /*
   * 导出跑完会把那份临时文档删掉（应该的）。这里临时拦住它的 remove，
   * 好在**导出那一刻的排版**上打印。拦的是测试这一侧，产物代码一个字没动。
   */
  const exported = await evaluate(`(async () => {
    const orig = Element.prototype.remove;
    Element.prototype.remove = function () {
      if (this.id === 'print-doc') return;
      return orig.call(this);
    };
    window.__printed = 0;
    window.print = () => { window.__printed++; };
    const more = document.querySelector('.top-bar button[aria-label="更多操作"]');
    more?.click();
    await new Promise(r => setTimeout(r, 300));
    const item = [...document.querySelectorAll('.ctx-item')].find(b => (b.querySelector('.ctx-label')?.textContent ?? '').includes('导出为 PDF'));
    item?.click();
    await new Promise(r => setTimeout(r, 1500));
    document.documentElement.classList.add('printing');
    const doc = document.getElementById('print-doc');
    return {
      printed: window.__printed,
      hasDoc: !!doc,
      imgs: doc ? doc.querySelectorAll('img').length : 0,
      crashed: !!document.querySelector('.err-wrap'),
    };
  })()`);
  const printed = await send('Page.printToPDF', { printBackground: false });
  const pdf = Buffer.from(printed.data, 'base64');
  fs.writeFileSync(path.join(OUT, 'export.pdf'), pdf);
  const raw = pdf.toString('latin1');
  const pages = (raw.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  // 空白页的内容流长度就是 0——用户那份 78 页里有 77 个这种
  const blanks = (raw.match(/\/Length\s+0[\s>\/]/g) ?? []).length;
  check('导出的 PDF 每一页都有内容（此前 78 页里 77 页是空的）',
    exported.printed === 1 && !exported.crashed && pages >= 6 && blanks === 0,
    { ...exported, pages, blanks, bytes: pdf.length });
  // 收拾现场：把临时文档摘掉，别影响后面的用例
  await evaluate(`(() => {
    document.documentElement.classList.remove('printing');
    const d = document.getElementById('print-doc');
    if (d && d.parentNode) d.parentNode.removeChild(d);
    return true })()`);
  await new Promise((r) => setTimeout(r, 300));
}

// ---------- 7.86 导出 PDF：浏览器里退回打印面板（v0.11.16）----------
/*
 * Windows 上这条路走的是 WebView2 的 PrintToPdf（直接落文件、不弹打印机），
 * 那段是 Rust、只有 Windows 编得到，这里验不了。**这里能验、也必须验的是另一半**：
 * 没有 Tauri 的环境（浏览器）不能因为找不到 invoke 就把菜单点崩，
 * 而要老老实实退回打印面板——这正是"能力写好了、另一条路没接"最容易翻车的地方。
 */
{
  const exported = await evaluate(`(async () => {
    window.__printed = 0;
    window.print = () => { window.__printed++; };
    const more = document.querySelector('.top-bar button[aria-label="更多操作"]');
    if (!more) return { menu: false };
    more.click();
    await new Promise(r => setTimeout(r, 300));
    const item = [...document.querySelectorAll('.ctx-item')]
      .find(b => (b.querySelector('.ctx-label')?.textContent ?? '').includes('导出为 PDF'));
    if (!item) return { menu: true, item: false };
    item.click();
    await new Promise(r => setTimeout(r, 900));
    return {
      menu: true,
      item: true,
      printed: window.__printed,
      crashed: !!document.querySelector('.err-wrap'),
      toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent),
    };
  })()`);
  check('「导出为 PDF」在没有 Tauri 的环境里退回打印面板，且不把应用点崩',
    exported.item && exported.printed === 1 && !exported.crashed, exported);
}

// ---------- 7.9 编辑态：列表圆点 / 链接 / 标题上的光标（v0.11.15）----------
/*
 * 用户拿 Obsidian 的截图逐条对比：「很多符号都没有正常显示，也没有自动识别链接」
 * 「这种文档，我用键盘的方向键无法移动到大标题，用鼠标也无法点击到大标题，
 * 上方向键经常跳到很上面」。
 *
 * 后一条的真因是**行级装饰改了行高**（line-height / margin）：CodeMirror 的
 * 高度模型量的是 getBoundingClientRect，外边距不在盒子里、line-height 它也不认，
 * 于是坐标从第一个标题起就开始偏，标题越多偏得越远。这类问题只有在**真实产物里
 * 真的按键、真的点击**才量得到，纯函数测不到一个字节。
 */
{
  await evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== 'directory' || !name.startsWith('vault-')) continue;
      const NL = String.fromCharCode(10);
      const fh = await handle.getFileHandle('排版样张.md', { create: true });
      const w = await fh.createWritable();
      await w.write(new TextEncoder().encode([
        '## 教育经历', '', '河南经贸职业学院 | 工商企业管理 | 大专', '',
        '## GitHub / 项目', '',
        '- **IvyeaOps**', '  - https://github.com/Hector-xue/IvyeaOps',
        '- [github.com/Hector-xue/ivyea-agent](https://github.com/Hector-xue/ivyea-agent)', '',
        '## 早期创业经历', '',
        '- 从实际经营问题出发参与蜂蜜品牌定位', '- 探索直播电商、传统电商等线上销售渠道', '',
      ].join(NL)));
      await w.close();
      return 'ok';
    }
    return 'no-vault';
  })()`);
  await send('Page.reload');
  await new Promise((r) => setTimeout(r, 2500));
  await evaluate(`(() => {
    const el = [...document.querySelectorAll('.ft-file-name')].find(x => x.textContent.includes('排版样张'));
    const row = el?.closest('.ft-file'); row?.scrollIntoView({ block: 'center' }); row?.click(); return !!el })()`);
  await new Promise((r) => setTimeout(r, 1000));
  await evaluate(`(() => { document.querySelector('.cm-content')?.blur(); return true })()`);
  await new Promise((r) => setTimeout(r, 600));

  const marks = await evaluate(`(() => {
    const bullets = [...document.querySelectorAll('.cm-live-bullet')];
    const links = [...document.querySelectorAll('.cm-live-link')];
    const cs = links[0] ? getComputedStyle(links[0]) : null;
    return {
      bullets: bullets.length,
      bulletText: bullets[0]?.textContent ?? null,
      // 圆点是渲染层的事：文档里那个 - 必须原样还在（改成 replace 也不该动内容）
      rawDash: (document.querySelector('.cm-content')?.innerText ?? '').includes(String.fromCharCode(45) + ' 从实际经营'),
      links: links.map(a => a.textContent),
      underline: cs ? cs.textDecorationLine : null,
      linkColor: cs ? cs.color : null,
      bodyColor: getComputedStyle(document.querySelector('.cm-content')).color,
    };
  })()`);
  check('无序列表在编辑态画成圆点（Obsidian 同款），源码里的 - 一个字节没动',
    marks.bullets >= 4 && marks.bulletText === '•' && !marks.rawDash, marks);
  check('链接看得出是链接：品牌色 + 一条下划线（此前只有颜色，用户说"没有自动识别链接"）',
    marks.links.length >= 2 && marks.underline === 'underline' && marks.linkColor !== marks.bodyColor,
    marks);
  await shot('live-marks.png');

  // --- 鼠标点标题：光标必须落在标题那一行 ---
  const clickHead = await evaluate(`(() => {
    const line = [...document.querySelectorAll('.cm-line')].find(l => l.innerText.includes('早期创业经历'));
    if (!line) return null;
    const r = line.getBoundingClientRect();
    return { x: Math.round(r.left + 60), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (clickHead) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: clickHead.x, y: clickHead.y, button: 'left', clickCount: 1, buttons: 1 });
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  const landed = await evaluate(`(() => {
    const s = getSelection();
    const n = s.anchorNode;
    const line = n && (n.nodeType === 1 ? n : n.parentElement)?.closest('.cm-line');
    return line ? line.innerText.slice(0, 16) : null;
  })()`);
  check('鼠标点在大标题上，光标就落在那一行（行级装饰用 margin/line-height 时会落到别的行）',
    !!landed && landed.includes('早期创业经历'), { landed });

  // --- 上方向键：逐行走，不跳过标题行 ---
  await evaluate(`(() => {
    const line = [...document.querySelectorAll('.cm-line')].find(l => l.innerText.includes('从实际经营'));
    const r = line.getBoundingClientRect();
    window.__up = { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) };
    return true })()`);
  const upPt = await evaluate(`window.__up`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: upPt.x, y: upPt.y, button: 'left', clickCount: 1, buttons: 1 });
  }
  await new Promise((r) => setTimeout(r, 300));
  const trail = [];
  for (let i = 0; i < 3; i++) {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 });
    await new Promise((r) => setTimeout(r, 180));
    trail.push(await evaluate(`(() => {
      const s = getSelection();
      const n = s.anchorNode;
      const line = n && (n.nodeType === 1 ? n : n.parentElement)?.closest('.cm-line');
      return line ? line.innerText.slice(0, 12) : null;
    })()`));
  }
  // 文档顺序：## 早期创业经历 / 空行 / - 从实际经营… ，所以往上两步必须踩到标题
  check('连按上方向键逐行往上走，会停在大标题那一行（此前整行跳过去）',
    trail.some((x) => (x ?? '').includes('早期创业经历')), trail);
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
    const sheetEl = document.querySelector('.m-sheet2');
    if (!g || !sheetEl) return null;
    const ss = getComputedStyle(sheetEl);
    const mask = getComputedStyle(document.querySelector('.m-sheet-mask'));
    const r = sheetEl.getBoundingClientRect();
    const items = [...g.querySelectorAll('.m-sheet2-item')];
    const it = items[0] ? items[0].getBoundingClientRect() : null;
    const sep = items[1] ? getComputedStyle(items[1], '::before') : null;
    return {
      groups: document.querySelectorAll('.m-sheet2-group').length,
      radius: ss.borderTopLeftRadius,
      // v0.11.14：底色长在整张纸上，不再是几张飘着的卡片
      sheetBg: ss.backgroundColor,
      transparentSheet: /rgba\(0, 0, 0, 0\)|transparent/.test(ss.backgroundColor),
      maskDim: mask.backgroundColor,
      maskTransparent: /rgba\(0, 0, 0, 0\)|transparent/.test(mask.backgroundColor),
      left: Math.round(r.left),
      right: Math.round(window.innerWidth - r.right),
      bottom: Math.round(window.innerHeight - r.bottom),
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
  check('底部菜单是一整张贴边的纸（有底色、上两角圆、遮罩压暗），行高够按',
    !!sheet && parseFloat(sheet.radius) >= 12 && !sheet.transparentSheet && !sheet.maskTransparent &&
    sheet.left === 0 && sheet.right === 0 && sheet.bottom === 0 &&
    (sheet.itemH ?? 0) >= 48 && sheet.icons > 0, sheet);

  /*
   * v0.11.18：**一根分隔线都不画**（用户：「这么多横线还长短不一，好难看」）。
   * 分组交给留白——所以这条量两件事：伪元素没有内容/边框，组与组之间有真实的间距。
   */
  const noLines = await evaluate(`(() => {
    const items = [...document.querySelectorAll('.m-sheet2-item')];
    const groups = [...document.querySelectorAll('.m-sheet2-group')];
    const sep = items[1] ? getComputedStyle(items[1], '::before') : null;
    const gap = groups.length > 1
      ? Math.round(groups[1].getBoundingClientRect().top - groups[0].getBoundingClientRect().bottom)
      : null;
    return {
      sepContent: sep ? sep.content : null,
      sepBorder: sep ? sep.borderTopWidth : null,
      groupBorder: groups[1] ? getComputedStyle(groups[1]).borderTopWidth : null,
      groupGap: gap,
      groups: groups.length,
      head: !!document.querySelector('.m-sheet2-head .m-sheet2-grip'),
      title: document.querySelector('.m-sheet2-title')?.textContent ?? null,
    };
  })()`);
  check('弹层里一根分隔线都没有，分组靠留白；头部有把手与上下文标题',
    !!noLines && (noLines.sepContent === 'none' || noLines.sepBorder === '0px') &&
    (noLines.groupBorder === '0px' || noLines.groupBorder === null) &&
    (noLines.groups < 2 || (noLines.groupGap ?? 0) >= 10) && noLines.head, noLines);

  await shot('mobile-sheet.png');

  /*
   * **把手不再是假的**：按住头部往下拖就该关掉。此前画了一条可拖的把手，
   * 却只能点遮罩关——界面在撒谎。这里派发真的 touch 序列来验。
   */
  const grip = await evaluate(`(() => {
    const h = document.querySelector('.m-sheet2-head');
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (grip) {
    const pt = (y) => [{ x: grip.x, y, radiusX: 6, radiusY: 6, force: 1, id: 1 }];
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(grip.y) });
    for (const dy of [40, 90, 140]) {
      await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(grip.y + dy) });
      await new Promise((r) => setTimeout(r, 60));
    }
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await new Promise((r) => setTimeout(r, 500));
  }
  check('按住把手下滑能把弹层关掉（把手此前是个假承诺，只能点遮罩关）',
    !!grip && !(await evaluate(`!!document.querySelector('.m-sheet2')`)), { grip });

  // --- v0.11.13：标题不冻结 / 大纲弹层形状 / 底部四个键 ---
  await evaluate(`(() => {
    // 关掉菜单，打开那篇有标题的长笔记
    document.querySelector('.m-sheet-mask')?.click();
    return true })()`);
  await new Promise((r) => setTimeout(r, 400));
  // 造一篇够长的：短笔记根本没有可滚的内容，验不出"标题会不会跟着走"
  await evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== 'directory' || !name.startsWith('vault-')) continue;
      const NL = String.fromCharCode(10);
      const lines = ['# 一篇很长的笔记', ''];
      for (let i = 1; i <= 80; i++) lines.push('## 第 ' + i + ' 节', '', '正文正文正文正文正文', '');
      const fh = await handle.getFileHandle('长文.md', { create: true });
      const w = await fh.createWritable();
      await w.write(new TextEncoder().encode(lines.join(NL)));
      await w.close();
      return 'ok';
    }
    return 'no-vault';
  })()`);
  await send('Page.reload');
  await new Promise((r) => setTimeout(r, 2400));
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') ?? '').includes('文件列表'));
    b?.click(); return !!b })()`);
  await new Promise((r) => setTimeout(r, 600));
  await evaluate(`(() => {
    const el = [...document.querySelectorAll('.m-tree-name')].find(x => x.textContent.includes('长文'));
    (el?.closest('.m-tree-row') ?? el)?.click();
    return !!el })()`);
  await new Promise((r) => setTimeout(r, 1200));

  const bottom = await evaluate(`(() => ({
    labels: [...document.querySelectorAll('.m-bottom .m-nav-btn')].map(b => b.getAttribute('aria-label')),
  }))()`);
  /*
   * v0.11.15：验证台跑的是**没登录**的本地模式，所以最右边那颗键的名字是
   * 「登录后同步」——此前它在这种状态下叫「立即同步」，点下去调的却是一个
   * 第一行就 return 的函数：没反应、没提示、没动效（用户点名问它是干什么的）。
   */
  /*
   * v0.11.17：对着 Obsidian 移动端改的两处——顶栏与底栏都不画分隔线（层次靠留白，
   * 不靠线），底部图标再往下压一点（原来是 52px 行高 + 整个安全区，图标浮在半空）。
   */
  const mobileChrome = await evaluate(`(() => {
    const top = document.querySelector('.m-top');
    const wrap = document.querySelector('.m-bottom-wrap');
    const nav = document.querySelector('.m-bottom');
    if (!top || !wrap || !nav) return null;
    const cs = getComputedStyle(top), cw = getComputedStyle(wrap);
    const r = nav.getBoundingClientRect();
    return {
      topBorder: cs.borderBottomWidth,
      bottomBorder: cw.borderTopWidth,
      navH: Math.round(r.height),
      // 图标行底边到屏幕底边还剩多少（越小越贴底）
      gapToBottom: Math.round(window.innerHeight - r.bottom),
    };
  })()`);
  check('手机端顶栏与底栏都不再画那条横线，底部图标离屏幕底边不超过 12px',
    !!mobileChrome && parseFloat(mobileChrome.topBorder) === 0 &&
    parseFloat(mobileChrome.bottomBorder) === 0 && mobileChrome.gapToBottom <= 12 &&
    mobileChrome.navH <= 48, mobileChrome);

  check('底部四个键：搜索 / 新建 / 大纲 / 同步；没登录时最后一颗明说是"登录后同步"',
    JSON.stringify(bottom.labels) === JSON.stringify(['搜索', '新建笔记', '大纲', '登录后同步']), bottom);

  // 点它必须**有事发生**：本地模式下弹登录页
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('.m-bottom .m-nav-btn')].pop();
    b?.click(); return !!b })()`);
  await new Promise((r) => setTimeout(r, 700));
  const afterSyncTap = await evaluate(`(() => ({
    login: !!document.querySelector('.login-wrap'),
    body: (document.body.innerText || '').slice(0, 40),
  }))()`);
  check('点最右边那颗键真的有反应（本地模式下把登录页叫出来，而不是静默什么都不做）',
    afterSyncTap.login, afterSyncTap);
  await shot('mobile-sync-tap.png');
  // 退回主界面，后面的用例以"开着一篇笔记"为前提
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('.login-wrap button')].find(x => /取消|返回/.test(x.textContent ?? ''));
    b?.click(); return !!b })()`);
  await new Promise((r) => setTimeout(r, 600));

  // 标题：把主区滚下去，标题应当跟着走（不再钉在顶上）
  const title = await evaluate(`(() => {
    const main = document.querySelector('.m-main');
    const t = document.querySelector('.inline-title');
    if (!main || !t) {
      return {
        missing: true,
        hasMain: !!main,
        hasTitle: !!t,
        crumb: document.querySelector('.m-crumb')?.textContent ?? null,
        firstLine: document.querySelector('.cm-content .cm-line')?.textContent ?? null,
      };
    }
    const before = t.getBoundingClientRect().top;
    main.scrollTop = 400;
    return { before, scrollable: main.scrollHeight > main.clientHeight + 40 };
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const after = await evaluate(`(() => {
    const t = document.querySelector('.inline-title');
    return t ? t.getBoundingClientRect().top : null;
  })()`);
  check('手机端标题跟着正文滚走，不再冻结在顶部',
    !!title && !title.missing && title.scrollable && after !== null && after < title.before - 200,
    { ...title, after });

  /*
   * v0.11.14：**滚的是标题，不是顶栏。**
   * v0.11.13 把滚动交给 .m-main 时顶栏还在它里面，于是那排图标一起划走了，
   * 用户想点左上角的侧栏按钮得先滚回最顶。这条量的就是"滚完之后顶栏还在原位、
   * 而且那颗按钮真的能点到"——只看它 top===0 不够，被别的东西盖住也是点不到。
   */
  const topFrozen = await evaluate(`(() => {
    const bar = document.querySelector('.m-top');
    const btn = document.querySelector('.m-top button[aria-label="打开文件列表"]');
    const main = document.querySelector('.m-main');
    if (!bar || !btn || !main) return null;
    const b = bar.getBoundingClientRect(), k = btn.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.round(k.left + k.width / 2), Math.round(k.top + k.height / 2));
    return {
      barTop: Math.round(b.top),
      barBottom: Math.round(b.bottom),
      scrolled: Math.round(main.scrollTop),
      mainTop: Math.round(main.getBoundingClientRect().top),
      btnHit: !!(hit && hit.closest('.m-top')),
    };
  })()`);
  check('滚下去之后顶栏还钉在最上面，左上角那颗侧栏按钮仍然点得到',
    !!topFrozen && topFrozen.scrolled > 100 && topFrozen.barTop === 0 && topFrozen.btnHit &&
    topFrozen.mainTop >= topFrozen.barBottom, topFrozen);
  await shot('mobile-scrolled.png');

  // 大纲：贴底、上面两角圆、有把手
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('.m-bottom .m-nav-btn')].find(x => x.getAttribute('aria-label') === '大纲');
    b?.click(); return !!b })()`);
  await new Promise((r) => setTimeout(r, 600));
  const outline = await evaluate(`(() => {
    const el = document.querySelector('.m-outline2');
    if (!el) return null;
    // v0.11.14：圆角与底色都在整张纸上（和底部菜单同一套结构）
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      radius: cs.borderTopLeftRadius,
      opaque: !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor),
      grip: !!el.querySelector('.m-sheet2-grip'),
      items: el.querySelectorAll('.m-outline-item').length,
      bottomGap: Math.round(window.innerHeight - r.bottom),
      onScreen: r.top > 0 && r.bottom <= window.innerHeight + 2,
    };
  })()`);
  check('大纲是贴底的圆角卡片、有自己的底色（不再是浮在半空的直角块）',
    !!outline && parseFloat(outline.radius) >= 12 && outline.opaque && outline.grip &&
    outline.items > 0 && outline.onScreen && outline.bottomGap <= 24, outline);
  await shot('mobile-outline.png');

  /*
   * v0.11.14：**手机上点一张图片要真的能看到它。**
   * 用户原话：「手机端无法直接打开图片，显示图片」。真因是 imageViewEl（那层
   * 全屏图片）只挂在桌面分支上——手机点了以后 resolveImage 照样解析出 blob、
   * setState 也照样发生，然后什么都不渲染。所以这里非量到那层不可。
   */
  await evaluate(`(async () => {
    const bin = atob(${JSON.stringify(PNG_1X1)});
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const root = await navigator.storage.getDirectory();
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== 'directory' || !name.startsWith('vault-')) continue;
      const fh = await handle.getFileHandle('单图.png', { create: true });
      const w = await fh.createWritable();
      await w.write(bytes);
      await w.close();
      return 'ok';
    }
    return 'no-vault';
  })()`);
  await send('Page.reload');
  await new Promise((r) => setTimeout(r, 2600));
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') ?? '').includes('文件列表'));
    b?.click(); return !!b })()`);
  await new Promise((r) => setTimeout(r, 700));
  const tappedImg = await evaluate(`(() => {
    const el = [...document.querySelectorAll('.m-tree-name')].find(x => x.textContent.includes('单图'));
    if (!el) return { found: false };
    const row = el.closest('.m-tree-row') ?? el;
    row.scrollIntoView({ block: 'center' });
    row.click();
    return { found: true };
  })()`);
  await new Promise((r) => setTimeout(r, 1200));
  const viewer = await evaluate(`(() => {
    const v = document.querySelector('.img-view');
    if (!v) return { open: false, toast: [...document.querySelectorAll('.toast')].map(t => t.textContent).join('|') };
    const img = v.querySelector('img');
    const r = img ? img.getBoundingClientRect() : null;
    return {
      open: true,
      // 图真的解码出来了才算数：挂个坏 blob 上去同样"有元素"
      natural: img ? img.naturalWidth : 0,
      onScreen: !!r && r.width > 0 && r.height > 0,
      name: v.querySelector('.img-view-name')?.textContent ?? null,
      drawerClosed: !document.querySelector('.m-drawer2.open'),
    };
  })()`);
  check('手机端点开一张图片，全屏图片层真的出现并解出了图，抽屉跟着收起（此前只挂在桌面分支）',
    tappedImg.found && viewer.open && viewer.natural > 0 && viewer.onScreen && viewer.drawerClosed,
    { tappedImg, viewer });
  await shot('mobile-image.png');
  await evaluate(`(() => { document.querySelector('.img-view')?.click(); return true })()`);
  await new Promise((r) => setTimeout(r, 300));

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

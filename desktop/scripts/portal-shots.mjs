/**
 * 门户与 README 用的产品截图（v0.11.17 起入库）。
 *
 * 用法：
 *   npm run build
 *   node scripts/portal-shots.mjs dist /要放截图的目录
 *
 * 为什么要有这个脚本：截图是**对外承诺**的一部分，而它最容易悄悄过期——
 * 界面改了三版，官网上还挂着两版之前的样子。手工截图既难对齐尺寸，也没人记得
 * 每次发版重拍。这里拿的是**真实构建产物**：起一个静态服务、真的把应用跑起来、
 * 真的点开侧栏与面板，再截图，和 verify-ui 同一套做法。
 *
 * 出图：shot-desktop / shot-search / shot-dark / shot-graph / shot-mobile
 * 桌面 1440x900 @2x（2880x1800），手机 390x844 @2x（780x1688）——
 * 尺寸与门户 index.html 里写死的 width/height 对齐，换图不用动 HTML。
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
  /*
   * 折叠状态是持久化的（localStorage），跨轮会串——上一轮把某个目录点收起来，
   * 这一轮截图里它就是收着的，而截图要展示的正是"库长什么样"。每次都清掉。
   */
  source: `try{localStorage.setItem('ivnote.welcomed','1');localStorage.removeItem('ivnote.collapsed');}catch(e){}`,
});

/** 截图前统一等一等：动画（侧栏宽度、面板切换）都是 200ms 级 */
const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));
const shot = async (file) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(OUT, file), Buffer.from(r.data, 'base64'));
  console.log('✓', file);
};
const desktopViewport = () =>
  send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
  });
const phoneViewport = () =>
  send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });

/*
 * 一份**像真人用了一阵子**的笔记库。
 *
 * 截图里的内容会被逐字读到，所以它得是站得住的：目录有层级、正文里有表格、
 * 任务、引用、标签和双链——这些正好也是要展示的能力。造一堆 lorem ipsum
 * 只会让人觉得"这软件没人用过"。
 */
const NL = String.fromCharCode(10);
const VAULT = {
  '欢迎使用 Ivyea Note.md': ['# 欢迎使用 Ivyea Note', '', '左边是你的文件夹，右边是大纲与反向链接。', '', '- 笔记就是磁盘上的 `.md` 文件', '- 同步服务器是你自己的那一台', ''].join(NL),
  '产品/新品上架清单.md': ['# 新品上架清单', '', '#产品', '', '- [x] 类目调研', '- [ ] 主图与 A+', '- [ ] 定价与广告预算', ''].join(NL),
  '日记/2026-09-09.md': ['# 2026-09-09', '', '## 待办', '- [ ] 复盘上周广告', '', '## 记录', '今天把 [[广告优化]] 的口径统一了。', ''].join(NL),
  '亚马逊/广告优化.md': [
    '# 广告优化', '', '#亚马逊 #广告', '',
    '> 本周只动出价，不动结构——一次只改一个变量，否则复盘时分不清是谁的功劳。', '',
    '## 本周指标', '',
    '| 广告活动 | 花费 | ACOS | 订单 |', '| --- | --- | --- | --- |',
    '| SP-手动-精准 | 1,284 | 18.4% | 62 |', '| SP-自动 | 906 | 31.2% | 24 |',
    '| SB-品牌词 | 412 | 12.7% | 19 |', '',
    '自动组的 ACOS 明显高于手动组，先从搜索词报告里把 15 次点击 0 单的词否掉。', '',
    '## 待办', '',
    '- [x] 导出上周搜索词报告', '- [ ] 否掉 15 次点击 0 单的词', '- [ ] 精准词出价 +10%，观察三天', '',
    '---', '', '关联：[[选品记录]] · [[ACOS 复盘]]', '',
  ].join(NL),
  '亚马逊/选品记录.md': ['# 选品记录', '', '#亚马逊', '', '按毛利率和竞争度两个维度筛，详见 [[广告优化]]。', ''].join(NL),
  '亚马逊/ACOS 复盘.md': ['# ACOS 复盘', '', '#亚马逊 #广告', '', '把 [[广告优化]] 里的三条动作各自的效果分开记。', ''].join(NL),
};

const seed = async () => {
  await evaluate(`(async () => {
    const files = ${JSON.stringify(VAULT)};
    const root = await navigator.storage.getDirectory();
    let vault = null;
    for await (const [name, h] of root.entries()) {
      if (h.kind === 'directory' && name.startsWith('vault-')) { vault = h; break; }
    }
    if (!vault) vault = await root.getDirectoryHandle('vault--1', { create: true });
    // 先清干净：截图不该混进上一轮跑测试留下的"甲乙丙""配色样张"
    for await (const [name, h] of vault.entries()) {
      await vault.removeEntry(name, { recursive: h.kind === 'directory' });
    }
    for (const [rel, text] of Object.entries(files)) {
      const parts = rel.split('/');
      let dir = vault;
      for (const seg of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(seg, { create: true });
      const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
      const w = await fh.createWritable();
      await w.write(new TextEncoder().encode(text));
      await w.close();
    }
    return 'ok';
  })()`);
};

const openNote = async (name) => {
  await evaluate(`(async () => {
    // 目录默认可能收着，先把它展开
    const dirs = [...document.querySelectorAll('.ft-dir-name')];
    for (const d of dirs) {
      const row = d.closest('.ft-dir');
      if (row && row.parentElement && !row.parentElement.querySelector('.ft-children')) row.click();
    }
    await new Promise(r => setTimeout(r, 400));
    const el = [...document.querySelectorAll('.ft-file-name')].find(x => x.textContent.includes(${JSON.stringify(name)}));
    const row = el?.closest('.ft-file');
    row?.scrollIntoView({ block: 'center' });
    row?.click();
    return !!row;
  })()`);
  await settle(900);
};
const clickRibbon = async (label) => {
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('.ribbon .ribbon-btn')].find(x => x.getAttribute('aria-label') === ${JSON.stringify(label)});
    b?.click(); return !!b })()`);
  await settle();
};
const setTheme = async (want) => {
  await evaluate(`(() => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark' ||
      document.documentElement.classList.contains('dark');
    return { dark };
  })()`);
  const now = await evaluate(`document.documentElement.getAttribute('data-theme') || 'light'`);
  if (now !== want) {
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === '切换主题');
      b?.click(); return !!b })()`);
    await settle(500);
  }
};

// ---------- 桌面 ----------
await desktopViewport();
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
await settle(2500);
await seed();
await send('Page.reload');
await settle(2600);
await setTheme('light');
await openNote('广告优化');
/*
 * 切到阅读视图：表格、任务、双链都成形，是最能说明"它在干什么"的一屏。
 * **每打开一篇都要切一次**——打开笔记会按偏好回到默认视图（编辑），
 * 上一次切过不算数（第一版深色截图就是这么拍成源码模式的）。
 */
const toReadView = async () => {
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') ?? '').includes('阅读'));
    b?.click(); return !!b })()`);
  await settle(900);
};
await toReadView();
await shot('shot-desktop.png');

// 搜索面板
await clickRibbon('搜索');
await evaluate(`(() => {
  const input = document.querySelector('.sidebar input');
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, 'ACOS');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true })()`);
await settle(900);
await shot('shot-search.png');

// 图谱（v0.11.17 起开在主区）。先切回文件树——截图里左栏应该是"库长什么样"，
// 而不是上一步留下的搜索结果
await clickRibbon('文件');
await clickRibbon('图谱');
await settle(2000);
await shot('shot-graph.png');
await evaluate(`(() => { document.querySelector('.graph-toolbar [aria-label="关闭"]')?.click(); return true })()`);
await settle();

// 深色
await clickRibbon('文件');
await openNote('广告优化');
await toReadView();
await setTheme('dark');
await settle(700);
await shot('shot-dark.png');
await setTheme('light');

// ---------- 手机 ----------
await phoneViewport();
await send('Page.reload');
await settle(2600);
await evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') ?? '').includes('文件列表'));
  b?.click(); return !!b })()`);
await settle();
await evaluate(`(async () => {
  // 目录默认是展开的（上面清过折叠状态），找不到就说明这一步该重看，不要瞎点
  let el = [...document.querySelectorAll('.m-tree-name')].find(x => x.textContent.includes('广告优化'));
  if (!el) {
    const dir = [...document.querySelectorAll('.m-tree-dir .m-tree-name')].find(x => x.textContent.trim() === '亚马逊');
    dir?.closest('.m-tree-dir')?.click();
    await new Promise(r => setTimeout(r, 500));
    el = [...document.querySelectorAll('.m-tree-name')].find(x => x.textContent.includes('广告优化'));
  }
  (el?.closest('.m-tree-row') ?? el)?.click();
  return !!el;
})()`);
await settle(1400);
await evaluate(`(() => {
  const b = [...document.querySelectorAll('.m-top .m-top-btn')].find(x => (x.getAttribute('aria-label') ?? '').includes('阅读'));
  b?.click(); return !!b })()`);
await settle(900);
await shot('shot-mobile.png');

ws.close();
chrome.kill();
server.close();
console.log(`\n截图已出：${OUT}`);
process.exit(0);

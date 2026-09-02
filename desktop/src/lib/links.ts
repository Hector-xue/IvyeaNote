/**
 * 链接路由（v0.10.2）。
 *
 * 此前**只有 `[[双链]]` 是可点的**：阅读模式给 `a.wikilink` 逐个绑了 click，
 * 普通 Markdown 链接 `[文字](https://…)` 无人接管——在 Tauri 的 WebView 里，
 * 一个没被拦下的 `<a href>` 会让**整个应用导航到那个地址**（白屏，只能重启），
 * 编辑态更是连渲染都没有，纯源码。所以用户看到的是「链接点了没反应 / 点了就废」。
 *
 * 这里把「一个 href 该怎么办」收成纯函数，阅读态与编辑态共用同一套判定，
 * 免得两边各写一份、再各错一次。
 */

export type LinkKind =
  /** 外部地址：交给系统浏览器 */
  | 'external'
  /** 页内锚点 `#标题` */
  | 'anchor'
  /** 库内笔记（.md / 无后缀） */
  | 'note'
  /** 库内其它文件（图片、PDF、附件） */
  | 'asset';

export interface ParsedLink {
  kind: LinkKind;
  /** external=原始 URL；anchor=去掉 # 的锚点；note/asset=**未解析**的相对路径 */
  target: string;
}

/** 走系统浏览器打开的协议。其余协议（file:、自定义 scheme）一律不碰 */
const EXTERNAL_SCHEME = /^(https?|mailto|tel):/i;
/** 任意协议前缀，用来区分「带 scheme」与「相对路径」 */
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** 当作笔记看待的后缀；无后缀也算笔记（Obsidian 的 `[文字](某笔记)` 写法） */
const NOTE_EXT = /\.(md|markdown)$/i;

/**
 * 判定一个 href 属于哪一类。
 *
 * 注意 `//example.com` 这种协议相对地址也是外部——漏判会被当成库内路径，
 * 于是「点了提示笔记不存在」。
 */
export function classifyLink(href: string): ParsedLink {
  const raw = (href ?? '').trim();
  if (!raw) return { kind: 'anchor', target: '' };
  if (raw.startsWith('#')) return { kind: 'anchor', target: raw.slice(1) };
  if (raw.startsWith('//')) return { kind: 'external', target: `https:${raw}` };
  if (EXTERNAL_SCHEME.test(raw)) return { kind: 'external', target: raw };
  // 带其它 scheme（file:、data:、obsidian:…）：不认识就当外部，交给系统去决定
  if (ANY_SCHEME.test(raw)) return { kind: 'external', target: raw };

  // 相对路径：先切掉 query / hash，再看后缀
  const clean = raw.split(/[?#]/)[0];
  if (!clean) return { kind: 'anchor', target: raw.replace(/^[?#]/, '') };
  const base = clean.split('/').pop() ?? clean;
  const hasExt = /\.[a-z0-9]+$/i.test(base);
  return { kind: hasExt && !NOTE_EXT.test(base) ? 'asset' : 'note', target: clean };
}

/**
 * 把相对链接解析成**库内相对路径**。
 *
 * `fromPath` 是当前笔记的库内路径（如 `子目录/今天.md`）——相对链接是相对**它所在
 * 目录**的，拿库根去拼会把 `图片.png` 解析到根目录下，附件全部裂开。
 *
 * 同时负责：URL 解码（中文文件名在 href 里是 %E4%B8%AD…）、消化 `./` 与 `../`、
 * 去掉前导 `/`（笔记里写绝对路径时指的是库根，不是磁盘根）。
 */
export function resolveVaultPath(fromPath: string | null, href: string): string {
  const clean = href.split(/[?#]/)[0];
  let rel: string;
  try {
    rel = decodeURIComponent(clean);
  } catch {
    rel = clean; // 半截百分号编码：原样用，总比抛异常把点击吃掉强
  }
  const fromDir =
    rel.startsWith('/') || !fromPath || !fromPath.includes('/')
      ? ''
      : fromPath.slice(0, fromPath.lastIndexOf('/'));
  const segs = [...fromDir.split('/'), ...rel.replace(/^\//, '').split('/')];
  const out: string[] = [];
  for (const s of segs) {
    if (!s || s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  return out.join('/');
}

/**
 * 笔记链接的候选路径：写 `[文字](某笔记)` 时后缀是省略的，
 * 得把 `.md` / `.markdown` 两种都试一遍。第一个是最常见的写法。
 */
export function noteCandidates(resolved: string): string[] {
  if (NOTE_EXT.test(resolved)) return [resolved];
  return [`${resolved}.md`, `${resolved}.markdown`, resolved];
}

/**
 * 标题锚点 slug。marked 生成的 `<h2 id="...">` 用的是 GitHub 口径
 * （小写、非字词字符去掉、空格转连字符），中文字符会原样保留。
 */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s]+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '');
}

/**
 * 在系统浏览器里打开外部地址。
 *
 * **绝不能让 WebView 自己导航过去**——那会把应用本身顶掉。Tauri 里走 opener
 * 插件；浏览器（开发 / web 版）里退回 `window.open`，并带上 noopener 防止
 * 目标页拿到 `window.opener`。
 */
export async function openExternal(url: string): Promise<void> {
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
    return;
  } catch {
    /* 非 Tauri 环境或插件不可用：往下走浏览器兜底 */
  }
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    /* 弹窗被拦：静默——这里没有能给用户看的地方，调用方负责提示 */
  }
}

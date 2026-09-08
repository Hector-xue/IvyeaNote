/**
 * v0.5.0 U1：Live Preview（对标 Obsidian）。
 * 用 CodeMirror 装饰 API 在编辑态直接渲染 Markdown 样式：
 * - 标题（#~###）→ 大字号粗体；行首标记光标不在时隐藏
 * - **加粗** / *斜体* / `代码` → 对应样式，标记符光标不在其中时隐藏
 * - > 引用 → 左边线 + 灰字
 * - - [ ] / - [x] 任务 → 渲染为可点击复选框（点击切换源码）
 *
 * v0.8.5（E4）补齐方案点名的四类，都是纯装饰、零新增依赖：
 * - `---` / `***` / `___` 分隔线 → 画成一条真的线
 * - 表格 → 等宽对齐、表头加重、`|---|` 分隔行淡出
 * - `> [!note]` callout → 按类型上色，`[!type]` 标记本身隐藏
 * - `[^1]` 脚注引用与 `[^1]:` 脚注定义 → 上标样式 + 定义行缩进
 *
 * 一律遵守既有规则：**光标靠近时显示源码**，否则显示渲染样式。
 */
import {
  ViewPlugin,
  Decoration,
  WidgetType,
  type DecorationSet,
  type EditorView as IEditorView,
} from '@codemirror/view';
import { EditorSelection, Facet, Range, StateEffect } from '@codemirror/state';

export const toggleTaskEffect = StateEffect.define<number>(); // 载荷：任务行内任意 offset

/**
 * v0.11.0：编辑态里的图片解析器。
 *
 * 用户原话是「插入的图片也没有直接展示」——核实下来不是"没做好"，是这个文件里
 * **从头到尾没有 image 分支**：图片只在「阅读模式」渲染，编辑态永远只有一行
 * `![xx](Attachments/xx.png)` 源码。Obsidian 的编辑态是直接显示图片的。
 *
 * 解析是异步的（要读盘/建 blob URL），而装饰必须同步产出，所以这里走
 * 「同步查缓存 + 缺了就 request + 拿到后派发 imagesReadyEffect 重建」：
 * - `get` 返回 `undefined` = 还没试过 → 触发 request，这一轮先不画；
 * - 返回 `null` = 试过但失败（文件不在）→ 画一个"图片未找到"的占位，
 *   而不是继续显示源码假装没事；
 * - 返回字符串 = 可用的 URL。
 */
export interface ImageApi {
  /** 同步取缓存：undefined=没试过，null=解析失败，string=可用 URL */
  get(src: string): string | null | undefined;
  /** 请求解析（幂等，内部自己去重）；完成后由调用方派发 imagesReadyEffect */
  request(src: string): void;
}

export const imageResolver = Facet.define<ImageApi | null, ImageApi | null>({
  combine: (values) => values.find((v) => v) ?? null,
});

/** 图片解析完成：让装饰重建一次。没有它，图片要等下一次敲键才出现 */
export const imagesReadyEffect = StateEffect.define<null>();

/**
 * 扫出全文里每一行属于哪个围栏代码块。
 *
 * 必须整篇扫，不能只看可视区：`visibleRanges` 从文档中间开始，
 * 单看一行永远判不出它在不在代码块里（这也是"只处理可见行"的装饰器
 * 做不了跨行语法的原因）。
 *
 * @returns 行号（1 起）→ 该行角色。不在代码块里的行不出现在表里。
 */
export function scanFences(lines: Iterable<string>): Map<number, 'open' | 'body' | 'close'> {
  const out = new Map<number, 'open' | 'body' | 'close'>();
  let open: { char: string; len: number } | null = null;
  let n = 0;
  for (const text of lines) {
    n++;
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (!open) {
      // 开围栏：``` 后面可以跟语言名；``` 里不允许再出现反引号
      if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
        open = { char: m[1][0], len: m[1].length };
        out.set(n, 'open');
      }
      continue;
    }
    // 闭围栏：同一种字符、不短于开围栏、后面没有别的内容
    if (m && m[1][0] === open.char && m[1].length >= open.len && m[2].trim() === '') {
      out.set(n, 'close');
      open = null;
      continue;
    }
    out.set(n, 'body');
  }
  return out;
}

export const livePreviewTheme = {
  '.cm-line': { lineHeight: '1.7' },
  '.cm-live-h1': { fontSize: '1.75em', fontWeight: '700', lineHeight: '1.3', marginTop: '0.4em' },
  '.cm-live-h2': { fontSize: '1.45em', fontWeight: '700', lineHeight: '1.35', marginTop: '0.35em' },
  '.cm-live-h3': { fontSize: '1.2em', fontWeight: '650' },
  '.cm-live-h4, .cm-live-h5, .cm-live-h6': { fontSize: '1.05em', fontWeight: '650' },
  '.cm-live-bold': { fontWeight: '700' },
  '.cm-live-italic': { fontStyle: 'italic' },
  /*
   * v0.11.8：删除线的字**不能再压到七成透明**。
   * 用户反馈「文档有些字的颜色太浅了」，指的就是这里：正文墨色是 #2b2a26，
   * 压到 0.7 之后实测约等于 #6f6e6a，在纸色背景上已经进入"次要文字"的亮度，
   * 整段读起来是灰的。删除线本身已经把"这条划掉了"说清楚了，颜色不必再帮腔。
   */
  '.cm-live-strike': { textDecoration: 'line-through', opacity: '0.88' },
  // 高亮：Obsidian 的 ==高亮== 。用品牌绿的极淡底，不用刺眼的荧光黄
  '.cm-live-mark': {
    background: 'color-mix(in srgb, var(--accent, #4a8) 22%, transparent)',
    borderRadius: '3px',
    padding: '0 2px',
  },
  // 编辑态图片。插件装饰不能是块级，所以是 inline-block + 自己撑高度
  '.cm-live-img': {
    display: 'inline-block',
    maxWidth: '100%',
    maxHeight: '420px',
    borderRadius: 'var(--r-1, 6px)',
    verticalAlign: 'text-bottom',
  },
  '.cm-live-img.alone': { display: 'block', margin: '6px 0' },
  '.cm-live-img-missing': {
    display: 'inline-block',
    padding: '2px 8px',
    border: '1px dashed var(--border, #ccc)',
    borderRadius: 'var(--r-1, 6px)',
    color: 'var(--muted, #888)',
    fontSize: '0.9em',
  },
  /*
   * 围栏代码块（v0.11.10）。
   *
   * 此前这个文件从头到尾**没有 fence 分支**：编辑态里 ``` 是三个字面量反引号，
   * 中间的代码按正文排版，还会被行内规则接着装饰（代码里的 `*ptr` 被画成斜体）。
   * 用户的原话是「我的代码块看不出来是代码块啊」——不是样式不好看，是压根没有。
   *
   * 底色铺在整行（Decoration.line）而不是包一层元素：CodeMirror 的行是虚拟滚动的，
   * 包元素会在滚动时被反复拆建。首行/末行单独给圆角，中间行不给，视觉上才是一块。
   */
  /* 任务行：整行悬挂缩进，折行后的文字对齐第一行的文本而不是顶到复选框下面 */
  '.cm-live-task': { paddingLeft: '1.7em', textIndent: '-1.7em' },
  '.cm-live-fence': {
    fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace)',
    fontSize: '0.9em',
    background: 'var(--code-bg, rgba(127,127,127,0.10))',
    borderLeft: '1px solid var(--border, rgba(127,127,127,0.25))',
    borderRight: '1px solid var(--border, rgba(127,127,127,0.25))',
    paddingLeft: '10px',
    paddingRight: '10px',
  },
  '.cm-live-fence-open': {
    borderTop: '1px solid var(--border, rgba(127,127,127,0.25))',
    borderTopLeftRadius: 'var(--r-2, 8px)',
    borderTopRightRadius: 'var(--r-2, 8px)',
    paddingTop: '4px',
  },
  '.cm-live-fence-close': {
    borderBottom: '1px solid var(--border, rgba(127,127,127,0.25))',
    borderBottomLeftRadius: 'var(--r-2, 8px)',
    borderBottomRightRadius: 'var(--r-2, 8px)',
    paddingBottom: '4px',
  },
  // 围栏那两行本身是语法不是内容：淡下去，但**不隐藏**——隐藏了就没法删它
  '.cm-live-fence-mark': { opacity: '0.45', fontSize: '0.85em' },
  '.cm-live-code': {
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
    fontSize: '0.9em',
    background: 'rgba(127,127,127,0.14)',
    borderRadius: '4px',
    padding: '1px 4px',
  },
  // 分隔线：把整行画成一条线，源码本身由 cm-live-marker 隐掉
  '.cm-live-hr': {
    borderBottom: '1px solid var(--border, #ccc)',
    height: '0.9em',
    margin: '0.5em 0',
  },
  // 表格：等宽才对得齐；表头加重，|---| 分隔行淡出（它是语法不是内容）
  '.cm-live-table': {
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
    fontSize: '0.92em',
  },
  '.cm-live-table-head': { fontWeight: '650' },
  '.cm-live-table-div': { opacity: '0.4' },
  // callout：只用左边线的颜色区分类型，不做底色——底色在正文里太吵
  '.cm-live-callout': { borderLeftWidth: '3px' },
  '.cm-callout-note, .cm-callout-info': { borderLeftColor: '#4a90d9' },
  '.cm-callout-tip, .cm-callout-success': { borderLeftColor: '#3fa45b' },
  '.cm-callout-warning, .cm-callout-caution': { borderLeftColor: '#d99a2b' },
  '.cm-callout-danger, .cm-callout-error, .cm-callout-bug': { borderLeftColor: '#d95a4a' },
  // 脚注：引用做成上标，定义行整体缩小并缩进
  '.cm-live-footnote-ref': {
    verticalAlign: 'super',
    fontSize: '0.75em',
    color: 'var(--accent, #3fa45b)',
  },
  '.cm-live-footnote-def': {
    fontSize: '0.9em',
    color: 'var(--muted, #888)',
    paddingLeft: '1.2em',
  },
  '.cm-live-quote': {
    color: 'var(--muted, #888)',
    borderLeft: '3px solid var(--border, #ccc)',
    paddingLeft: '10px',
    opacity: '0.92',
  },
  '.cm-live-marker': { color: 'transparent', fontSize: '0px' },
  // 链接：颜色 + 手型即可。下划线留给 hover——满屏下划线会把正文切碎
  '.cm-live-link': {
    color: 'var(--accent, #4a8)',
    cursor: 'pointer',
    textDecoration: 'none',
  },
  '.cm-live-link:hover': { textDecoration: 'underline' },
  '.cm-task-checkbox': {
    border: '1.5px solid var(--muted, #999)',
    borderRadius: '3px',
    width: '14px',
    height: '14px',
    display: 'inline-block',
    marginRight: '6px',
    cursor: 'pointer',
    verticalAlign: 'middle',
    fontSize: '11px',
    lineHeight: '13px',
    textAlign: 'center',
    userSelect: 'none',
  },
  '.cm-task-checked': { background: 'var(--accent, #4a8)', borderColor: 'var(--accent, #4a8)' },
  '.cm-task-checked-text': { textDecoration: 'line-through', opacity: '0.88' },
};

interface TaskHit {
  boxFrom: number;
  boxTo: number;
  textFrom: number;
  checked: boolean;
}
void (0 as unknown as TaskHit | null);

/**
 * 光标是否在区间附近（附近=区间内或紧贴边缘±1，此时显示源码）。
 *
 * `focused=false` 时一律返回 false ——**编辑器没有焦点时不该露出任何语法标记**。
 * 此前没有这个条件，于是每次打开一篇笔记，光标默认落在偏移 0（正好是标题行），
 * 标题就顶着一个 `#` 显示，看起来像是「渲染坏了」。Obsidian 是失焦即全部隐藏。
 */
function cursorNear(sel: EditorSelection, from: number, to: number, focused: boolean): boolean {
  if (!focused) return false;
  return sel.ranges.some((r) => r.to >= from - 1 && r.from <= to + 1);
}

/** 从行文本解析任务语法（支持 -, *, + 列表符），返回源码内绝对 offset */
export function parseTaskLine(
  lineText: string,
  lineFrom: number
): {
  /** 列表符号（- * +）的位置：渲染时连它一起换掉，别让复选框前面还挂着一个 `-` */
  markFrom: number;
  boxFrom: number;
  boxTo: number;
  textFrom: number;
  checked: boolean;
} | null {
  const m = lineText.match(/^(\s*)([-*+])\s+\[( |x|X)\]\s*/);
  if (!m) return null;
  const bracketPos = lineText.indexOf('[');
  const boxFrom = lineFrom + bracketPos;
  return {
    markFrom: lineFrom + m[1].length,
    boxFrom,
    boxTo: boxFrom + 3,
    textFrom: lineFrom + m[0].length,
    checked: m[3].toLowerCase() === 'x',
  };
}

/** 分隔线：整行只有 3 个以上的 - * _（允许其间有空格）。返回 true 表示这行是 hr */
export function isHorizontalRule(lineText: string): boolean {
  const t = lineText.trim();
  if (t.length < 3) return false;
  // setext 二级标题也是 ---，但它必须紧跟在正文行后面；这里只认「整行同一种符号」
  return /^(-{3,}|\*{3,}|_{3,})$/.test(t.replace(/\s+/g, ''));
}

/** 表格行：以 | 开头（允许前导空白）。Markdown 表格在 CM 里就是一行行的文本 */
export function isTableRow(lineText: string): boolean {
  return /^\s*\|.*\|\s*$/.test(lineText) && lineText.trim().length > 1;
}

/** 表格分隔行：|---|:--:|---:| 这种，只由 | - : 空格组成且含至少一个 - */
export function isTableDivider(lineText: string): boolean {
  return isTableRow(lineText) && /^[\s|:-]+$/.test(lineText) && lineText.includes('-');
}

/** Obsidian 风格 callout：`> [!note] 可选标题`。返回类型与标记区间（相对行首） */
export function parseCallout(
  lineText: string
): { type: string; markStart: number; markEnd: number } | null {
  const m = lineText.match(/^(\s*>\s?)(\[!([a-zA-Z]+)\]\s?)/);
  if (!m) return null;
  return { type: m[3].toLowerCase(), markStart: m[1].length, markEnd: m[1].length + m[2].length };
}

/** 脚注定义行：`[^1]: 正文`。返回标记结束位置（相对行首） */
export function parseFootnoteDef(lineText: string): { label: string; markEnd: number } | null {
  const m = lineText.match(/^\s*\[\^([^\]]+)\]:\s?/);
  return m ? { label: m[1], markEnd: m[0].length } : null;
}

/** 行内脚注引用 `[^1]`，返回全部区间（相对行首） */
export function findFootnoteRefs(lineText: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  const re = /\[\^([^\]\s]+)\](?!:)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lineText))) out.push({ from: m.index, to: m.index + m[0].length });
  return out;
}

/**
 * 行内 Markdown 链接 `[文字](地址 "可选标题")`。返回**相对行首**的偏移。
 * 只认单行（Markdown 的行内链接本来就不跨行），地址里不允许空格——
 * 带空格的地址在 Markdown 里必须用 <> 包起来，那种写法极少见，先不认。
 */
export function findInlineLinks(
  lineText: string
): { from: number; to: number; textFrom: number; textTo: number; href: string }[] {
  const out: { from: number; to: number; textFrom: number; textTo: number; href: string }[] = [];
  // 前面不能紧跟 `!`，否则那是图片 `![alt](src)`——图片不该变成可点链接
  const re = /(!?)\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lineText))) {
    if (m[1] === '!') continue;
    // `[[双链]]` 会让内层匹配成 `[双链]`——排掉，双链有自己的渲染与跳转
    if (lineText.slice(Math.max(0, m.index - 1), m.index) === '[') continue;
    const from = m.index;
    const textFrom = from + 1;
    out.push({ from, to: from + m[0].length, textFrom, textTo: textFrom + m[2].length, href: m[3] });
  }
  return out;
}

/**
 * 裸 URL（`https://…` 直接写在正文里）。
 *
 * 结尾的中英文标点要剔掉——`见 https://a.com/b。` 里的句号不属于地址，
 * 连进去会打开一个 404。成对括号同理（维基百科链接常带括号，只去掉多出来的那个）。
 */
export function findBareUrls(lineText: string): { from: number; to: number; href: string }[] {
  const out: { from: number; to: number; href: string }[] = [];
  const re = /https?:\/\/[^\s<>"']+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lineText))) {
    // 已经在 Markdown 链接语法里的地址不重复处理（那边有自己的装饰）
    const prev = lineText[m.index - 1];
    if (prev === '(' || prev === '<') continue;
    let url = m[0];
    while (url.length > 0) {
      const last = url[url.length - 1];
      if ('.,;:!?、。，；：！？）】」』'.includes(last)) url = url.slice(0, -1);
      else if (last === ')' && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0))
        url = url.slice(0, -1);
      else break;
    }
    if (url.length > 8) out.push({ from: m.index, to: m.index + url.length, href: url });
  }
  return out;
}

/**
 * 行内图片 `![alt](src)` 与 Obsidian 的 `![[src]]`。返回**相对行首**的偏移。
 *
 * `alone` 表示这一行除了这张图什么都没有——只有这种情况才把源码整段藏掉、
 * 让图片独占一行；夹在文字中间的图片藏掉源码会让那行读不通。
 */
export function findImages(
  lineText: string
): { from: number; to: number; src: string; alt: string; alone: boolean }[] {
  const out: { from: number; to: number; src: string; alt: string; alone: boolean }[] = [];
  const re = /!\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]|!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lineText))) {
    const src = m[1] ?? m[3];
    if (!src) continue;
    const alt = m[1] ? m[1] : (m[2] ?? '');
    out.push({
      from: m.index,
      to: m.index + m[0].length,
      src,
      alt,
      alone: lineText.trim() === m[0].trim(),
    });
  }
  return out;
}

/** 编辑态的图片。行内 widget（插件装饰不能是块级），靠 CSS 做成 inline-block */
class ImageWidget extends WidgetType {
  constructor(
    readonly url: string | null,
    readonly alt: string,
    readonly src: string,
    readonly alone: boolean
  ) {
    super();
  }
  override eq(other: ImageWidget) {
    return other.url === this.url && other.alt === this.alt && other.alone === this.alone;
  }
  override toDOM() {
    if (this.url === null) {
      const miss = document.createElement('span');
      miss.className = 'cm-live-img-missing';
      miss.textContent = `图片未找到：${this.src}`;
      return miss;
    }
    const img = document.createElement('img');
    img.className = `cm-live-img${this.alone ? ' alone' : ''}`;
    img.src = this.url;
    img.alt = this.alt;
    img.loading = 'lazy';
    // 右键菜单要拿得到**库内**路径；img.src 那时已经是 blob URL，说明不了任何事
    img.dataset.src = this.src;
    // 图片加载完高度才定下来，不通知 CM 的话行高会停在 0（正文被压成一条）
    img.addEventListener('load', () => img.dispatchEvent(new Event('cm-resize', { bubbles: true })));
    return img;
  }
  /** 点击图片要能选中/放大，不该被编辑器吞掉 */
  override ignoreEvent() {
    return false;
  }
}

class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  override eq(other: TaskWidget) {
    return other.checked === this.checked;
  }
  override toDOM() {
    const span = document.createElement('span');
    span.className = `cm-task-checkbox${this.checked ? ' cm-task-checked' : ''}`;
    span.textContent = this.checked ? '✓' : '';
    span.setAttribute('aria-label', this.checked ? '已完成任务' : '未完成任务');
    return span;
  }
  override ignoreEvent() {
    return false;
  }
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;

    constructor(view: IEditorView) {
      this.build(view);
    }

    update(u: any) {
      // focusChanged 必须参与：失焦/聚焦会改变「要不要显示标记」，不重建就不生效
      // imagesReadyEffect：图片解析是异步的，不重建的话图片要等下一次敲键才出现
      const imagesReady = u.transactions.some((tr: any) =>
        tr.effects.some((e: any) => e.is(imagesReadyEffect))
      );
      if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged || imagesReady) {
        this.build(u.view);
      }
      /*
       * 响应复选框点击：切换该行任务状态。
       *
       * **必须放到下一个微任务里 dispatch。** 在 `update()` 里同步派发事务，
       * CodeMirror 会抛「Calls to EditorView.dispatch are not allowed while an
       * update is in progress」——而 ViewPlugin 抛异常的后果是**整个插件被停用**，
       * 屏幕上所有 Live Preview 装饰当场消失。用户看到的现象就是
       * 「任务列表打勾无法点击，点一下就变成中括号了」：不是没接点击，
       * 是接了之后把渲染层整个搞崩了。
       */
      for (const tr of u.transactions) {
        for (const e of tr.effects) {
          if (e.is(toggleTaskEffect)) {
            const pos = e.value;
            queueMicrotask(() => {
              const view = u.view;
              if (pos > view.state.doc.length) return;
              const line = view.state.doc.lineAt(pos);
              const hit = parseTaskLine(line.text, line.from);
              if (!hit) return;
              const bracketOffset = line.from + line.text.indexOf('[');
              view.dispatch({
                changes: {
                  from: bracketOffset + 1,
                  to: bracketOffset + 2,
                  insert: hit.checked ? ' ' : 'x',
                },
              });
            });
          }
        }
      }
    }

    build(view: IEditorView) {
      const decos: Range<Decoration>[] = [];
      const sel = view.state.selection;
      const focused = view.hasFocus;
      const imgApi = view.state.facet(imageResolver);
      const fences = scanFences(view.state.doc.iterLines());
      for (const { from, to } of view.visibleRanges) {
        let pos = from;
        while (pos <= to) {
          const line = view.state.doc.lineAt(pos);
          const t = line.text;

          // ---- 围栏代码块（v0.11.10）----
          // 放在最前面：代码块里的 `#`、`*ptr`、`|` 都是代码，不是 Markdown 语法。
          const fence = fences.get(line.number);
          if (fence) {
            const edge = fence === 'open' || fence === 'close';
            decos.push(
              Decoration.line({
                class: `cm-live-fence${
                  fence === 'open' ? ' cm-live-fence-open' : fence === 'close' ? ' cm-live-fence-close' : ''
                }`,
              }).range(line.from)
            );
            if (edge && line.to > line.from) {
              decos.push(Decoration.mark({ class: 'cm-live-fence-mark' }).range(line.from, line.to));
            }
            pos = line.to + 1;
            continue;
          }

          // ---- 分隔线（E4）----
          if (isHorizontalRule(t)) {
            decos.push(Decoration.line({ class: 'cm-live-hr' }).range(line.from));
            if (!cursorNear(sel, line.from, line.to, focused)) {
              decos.push(Decoration.mark({ class: 'cm-live-marker' }).range(line.from, line.to));
            }
            pos = line.to + 1;
            continue;
          }

          // ---- 表格（E4）----
          if (isTableRow(t)) {
            const divider = isTableDivider(t);
            // 表头 = 紧跟在分隔行之前的那一行
            const nextIsDivider =
              line.number < view.state.doc.lines &&
              isTableDivider(view.state.doc.line(line.number + 1).text);
            decos.push(
              Decoration.line({
                class: `cm-live-table${divider ? ' cm-live-table-div' : ''}${
                  nextIsDivider ? ' cm-live-table-head' : ''
                }`,
              }).range(line.from)
            );
            pos = line.to + 1;
            continue;
          }

          // ---- 标题 ----
          const h = t.match(/^(#{1,6})\s+(.*)$/);
          if (h) {
            const markTo = line.from + h[1].length + 1;
            decos.push(Decoration.line({ class: `cm-live-h${h[1].length}` }).range(line.from));
            if (!cursorNear(sel, line.from, markTo, focused)) {
              decos.push(Decoration.mark({ class: 'cm-live-marker' }).range(line.from, markTo));
            }
          } else {
            // ---- 引用 ----
            const gm = t.match(/^\s*>\s?/);
            if (gm) {
              // callout（E4）：`> [!note] 标题` —— 按类型上色，标记本身隐藏
              const call = parseCallout(t);
              decos.push(
                Decoration.line({
                  class: call ? `cm-live-quote cm-live-callout cm-callout-${call.type}` : 'cm-live-quote',
                }).range(line.from)
              );
              const markTo = line.from + (call ? call.markEnd : gm[0].length);
              if (!cursorNear(sel, line.from, markTo, focused)) {
                decos.push(Decoration.mark({ class: 'cm-live-marker' }).range(line.from, markTo));
              }
            }

            // ---- 脚注（E4）----
            const fdef = parseFootnoteDef(t);
            if (fdef) {
              decos.push(Decoration.line({ class: 'cm-live-footnote-def' }).range(line.from));
            }
            for (const r of findFootnoteRefs(t)) {
              const fs = line.from + r.from;
              const fe = line.from + r.to;
              if (!cursorNear(sel, fs, fe, focused)) {
                decos.push(Decoration.mark({ class: 'cm-live-footnote-ref' }).range(fs, fe));
              }
            }
          }

          /*
           * ---- 以下是**行内**装饰：每一行都要跑，包括标题行。 ----
           *
           * v0.11.2 之前这一整段写在上面那个 `else` 里面，也就是说
           * **标题行上的行内语法从来没有被渲染过**：`# 标题里的 **加粗**` 会一直
           * 露出星号，链接点不动，图片也不显示。粘贴图片时光标恰好停在标题行，
           * 于是"粘贴了但看不见"——查到最后才发现根本不是粘贴的问题。
           * 引用/脚注/表格那些是**行级**语法，留在上面按行分支；行内的东西没有
           * 任何理由挑行。
           *
           * ---- 行内：加粗 / 删除线 / 高亮 / 行内代码 / 斜体 ----
           *
           * v0.11.0 修了一个一直摆在眼前的错位：旧正则是
           * `(\*\*…\*\*)|(\*…\*)|(`…`)`，分组编号是 1/3/5，而判定写的是
           * `im[1] → 加粗，im[3] → 行内代码，其余 → 斜体`——im[3] 是**斜体**那一支。
           * 于是 `*斜体*` 一直被画成灰底的行内代码，`` `代码` `` 反而画成斜体，
           * 两个样式整整互换着用了六个版本。现在去掉内层捕获组，一支一行，
           * marker 长度跟着支走，不再靠数括号。
           */
          const inlineRe = /(\*\*[^*]+\*\*)|(~~[^~\n]+~~)|(==[^=\n]+==)|(`[^`]+`)|(\*[^*\n]+\*)/g;
          const INLINE: { group: number; cls: string; mark: number }[] = [
            { group: 1, cls: 'cm-live-bold', mark: 2 },
            { group: 2, cls: 'cm-live-strike', mark: 2 },
            { group: 3, cls: 'cm-live-mark', mark: 2 },
            { group: 4, cls: 'cm-live-code', mark: 1 },
            { group: 5, cls: 'cm-live-italic', mark: 1 },
          ];
          let im: RegExpExecArray | null;
          while ((im = inlineRe.exec(t))) {
            const start = line.from + im.index;
            const end = start + im[0].length;
            if (cursorNear(sel, start, end, focused)) continue;
            const hit = INLINE.find((k) => im![k.group]);
            if (!hit) continue;
            decos.push(Decoration.mark({ class: hit.cls }).range(start + hit.mark, end - hit.mark));
            decos.push(Decoration.mark({ class: 'cm-live-marker' }).range(start, start + hit.mark));
            decos.push(Decoration.mark({ class: 'cm-live-marker' }).range(end - hit.mark, end));
          }

          // ---- 图片（v0.11.0）：编辑态直接显示，不再只是一行源码 ----
          if (imgApi) {
            for (const img of findImages(t)) {
              const start = line.from + img.from;
              const end = line.from + img.to;
              if (cursorNear(sel, start, end, focused)) continue;
              const got = imgApi.get(img.src);
              if (got === undefined) {
                // 还没解析过：这一轮先放着，解析完会派发 imagesReadyEffect 再来一次
                imgApi.request(img.src);
                continue;
              }
              decos.push(Decoration.mark({ class: 'cm-live-marker' }).range(start, end));
              decos.push(
                Decoration.widget({
                  widget: new ImageWidget(got, img.alt, img.src, img.alone),
                  side: 1,
                }).range(end)
              );
            }
          }

          // ---- 行内链接（v0.10.2）----
          // 不渲染成可点的话，编辑态里链接就只是一串源码；而 `[文字](地址)`
          // 这种写法在阅读态之外**从来没有过入口**。光标靠近时退回源码，
          // 否则改不动自己写的链接。
          const links = findInlineLinks(t);
          for (const lk of links) {
            const start = line.from + lk.from;
            const end = line.from + lk.to;
            if (cursorNear(sel, start, end, focused)) continue;
            const tf = line.from + lk.textFrom;
            const tt = line.from + lk.textTo;
            // 空文字 `[](地址)`：没有可点的东西，保持源码原样
            if (tt <= tf) continue;
            decos.push(
              Decoration.mark({
                class: 'cm-live-link',
                attributes: { 'data-href': lk.href, title: lk.href },
              }).range(tf, tt)
            );
            // 与本文件其它语法标记一致，用 cm-live-marker 隐藏而不是 replace：
            // replace 会改动光标在文档里的映射，方向键走到链接上就会跳格
            decos.push(Decoration.mark({ class: 'cm-live-marker' }).range(start, tf));
            decos.push(Decoration.mark({ class: 'cm-live-marker' }).range(tt, end));
          }
          for (const u of findBareUrls(t)) {
            // 落在 `[文字](地址)` 内部的地址已由上面处理
            if (links.some((lk) => u.from >= lk.from && u.to <= lk.to)) continue;
            const start = line.from + u.from;
            const end = line.from + u.to;
            decos.push(
              Decoration.mark({
                class: 'cm-live-link',
                attributes: { 'data-href': u.href, title: u.href },
              }).range(start, end)
            );
          }

          /*
           * ---- 任务复选框（v0.11.11 大改）----
           *
           * 三件事一起改，因为它们是同一个毛病的三个面（用户原话：「任务列表打勾
           * 无法点击，点一下就变成中括号了，前面还有一个 -，且右侧文案没有缩进」）：
           *
           * 1. **光标在这一行时也要保持渲染。** 原来跟其它语法一样走 `cursorNear`：
           *    点复选框会把光标落到这一行，装饰当即撤掉，于是"点一下就变成中括号"。
           *    复选框不是语法标记，它是个控件——Obsidian 在光标进入任务行时同样
           *    保留它。真要改源码，把光标移到 `[` 之内（下面的判定）就会显形。
           * 2. **连列表符号一起换掉。** 原来只替换 `[ ]` 三个字符，前面那个 `- `
           *    还留在屏幕上，成了"复选框前面还有一个 -"。
           * 3. **整行做悬挂缩进。** 折行后的文字要对齐第一行的文本，而不是顶到
           *    复选框下面（`.cm-live-task` 那条 CSS）。
           */
          const task = parseTaskLine(t, line.from);
          if (task) {
            /*
             * **复选框一律渲染，不看光标在哪。**
             *
             * 先试过"光标落进方括号才显形"，实测仍然不行：点复选框时 CodeMirror
             * 会把光标落在被替换区间的边界上，`cursorNear` 的 ±1 容差当场命中，
             * 于是"点一下就变成中括号"照旧（这条是拿真实产物点出来的，不是看代码想的）。
             *
             * 复选框是控件不是语法标记：Obsidian 的 Live Preview 里它也从不退回
             * `- [ ]`。要改回源码有的是路——切源码模式，或者在文字处退格把它删掉。
             */
            decos.push(Decoration.line({ class: 'cm-live-task' }).range(line.from));
            decos.push(
              Decoration.replace({ widget: new TaskWidget(task.checked) }).range(task.markFrom, task.boxTo)
            );
            if (task.checked && task.textFrom < line.to) {
              decos.push(Decoration.mark({ class: 'cm-task-checked-text' }).range(task.textFrom, line.to));
            }
          }
          pos = line.to + 1;
        }
      }
      this.decorations = Decoration.set(decos, true);
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      mousedown(e: MouseEvent, view: any) {
        const target = e.target as HTMLElement;
        if (target.classList?.contains('cm-task-checkbox')) {
          const pos = view.posAtDOM(target);
          view.dispatch({ effects: toggleTaskEffect.of(pos) });
          e.preventDefault();
          return true;
        }
        return false;
      },
    },
  }
);

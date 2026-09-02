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
import { EditorSelection, Range, StateEffect } from '@codemirror/state';

export const toggleTaskEffect = StateEffect.define<number>(); // 载荷：任务行内任意 offset

export const livePreviewTheme = {
  '.cm-line': { lineHeight: '1.7' },
  '.cm-live-h1': { fontSize: '1.75em', fontWeight: '700', lineHeight: '1.3', marginTop: '0.4em' },
  '.cm-live-h2': { fontSize: '1.45em', fontWeight: '700', lineHeight: '1.35', marginTop: '0.35em' },
  '.cm-live-h3': { fontSize: '1.2em', fontWeight: '650' },
  '.cm-live-h4, .cm-live-h5, .cm-live-h6': { fontSize: '1.05em', fontWeight: '650' },
  '.cm-live-bold': { fontWeight: '700' },
  '.cm-live-italic': { fontStyle: 'italic' },
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
  '.cm-task-checked-text': { textDecoration: 'line-through', opacity: '0.6' },
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
): { boxFrom: number; boxTo: number; textFrom: number; checked: boolean } | null {
  const m = lineText.match(/^(\s*)([-*+])\s+\[( |x|X)\]\s*/);
  if (!m) return null;
  const bracketPos = lineText.indexOf('[');
  const boxFrom = lineFrom + bracketPos;
  return {
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
      if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged) {
        this.build(u.view);
      }
      // 响应复选框点击：切换该行任务状态
      for (const tr of u.transactions) {
        for (const e of tr.effects) {
          if (e.is(toggleTaskEffect)) {
            const line = u.view.state.doc.lineAt(e.value);
            const hit = parseTaskLine(line.text, line.from);
            if (hit) {
              const bracketOffset = line.from + line.text.indexOf('[');
              u.view.dispatch({
                changes: {
                  from: bracketOffset + 1,
                  to: bracketOffset + 2,
                  insert: hit.checked ? ' ' : 'x',
                },
              });
            }
          }
        }
      }
    }

    build(view: IEditorView) {
      const decos: Range<Decoration>[] = [];
      const sel = view.state.selection;
      const focused = view.hasFocus;
      for (const { from, to } of view.visibleRanges) {
        let pos = from;
        while (pos <= to) {
          const line = view.state.doc.lineAt(pos);
          const t = line.text;

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

            // ---- 行内：加粗 / 斜体 / 行内代码 ----
            const inlineRe = /(\*\*([^*]+)\*\*)|(\*([^*\n]+)\*)|(`([^`]+)`)/g;
            let im: RegExpExecArray | null;
            while ((im = inlineRe.exec(t))) {
              const start = line.from + im.index;
              const end = start + im[0].length;
              if (cursorNear(sel, start, end, focused)) continue;
              if (im[1]) {
                decos.push(Decoration.mark({ class: 'cm-live-bold' }).range(start + 2, end - 2));
                decos.push(Decoration.mark({ class: 'cm-live-marker' }).range(start, start + 2));
                decos.push(Decoration.mark({ class: 'cm-live-marker' }).range(end - 2, end));
              } else if (im[3]) {
                decos.push(Decoration.mark({ class: 'cm-live-code' }).range(start + 1, end - 1));
                decos.push(Decoration.mark({ class: 'cm-live-marker' }).range(start, start + 1));
                decos.push(Decoration.mark({ class: 'cm-live-marker' }).range(end - 1, end));
              } else {
                decos.push(Decoration.mark({ class: 'cm-live-italic' }).range(start + 1, end - 1));
                decos.push(Decoration.mark({ class: 'cm-live-marker' }).range(start, start + 1));
                decos.push(Decoration.mark({ class: 'cm-live-marker' }).range(end - 1, end));
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

            // ---- 任务复选框 ----
            const task = parseTaskLine(t, line.from);
            if (task && !cursorNear(sel, task.boxFrom, task.textFrom, focused)) {
              decos.push(Decoration.replace({ widget: new TaskWidget(task.checked) }).range(task.boxFrom, task.boxTo));
              if (task.checked && task.textFrom < line.to) {
                decos.push(Decoration.mark({ class: 'cm-task-checked-text' }).range(task.textFrom, line.to));
              }
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

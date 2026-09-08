/**
 * MarkdownEditor（v0.3.4）：桌面/移动共用的编辑器组件。
 * - CodeMirror 6 内核（Obsidian 同款），移动端不再用裸 textarea
 * - 格式化工具栏：加粗/斜体/标题/列表/引用/代码/链接/插图（桌面顶部、移动底部）
 * - 阅读模式：marked + DOMPurify 渲染，图片按相对路径真实显示
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  highlightActiveLine,
  drawSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { syntaxHighlighting, indentUnit } from '@codemirror/language';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { marked } from 'marked';
import { RibbonIcon, type IconName } from './Icons';
import DOMPurify from 'dompurify';
import {
  clearFormatting,
  cycleHeading,
  insertBlock,
  insertImage,
  insertLink,
  insertText,
  insertWikiLink,
  setHeading,
  toggleInline,
  toggleLinePrefix,
  toggleOrderedList,
  toggleTaskList,
  type EditResult,
} from '../lib/format';
import {
  imageResolver,
  imagesReadyEffect,
  livePreview,
  livePreviewTheme,
  type ImageApi,
} from '../lib/livePreview';
import { ContextMenu, type MenuAnchor } from './ContextMenu';
import { blockSnippet, buildEditorMenu } from '../lib/editorMenu';
import { raiseToast } from './Toast';
import { autocompletion } from '@codemirror/autocomplete';
import { wikiCompletion } from '../lib/wikiComplete';
import { renderWikiLinks } from '../lib/wikilink';
import { classifyLink, headingSlug, openExternal, resolveVaultPath } from '../lib/links';
import { encodeHref, noteRelative } from '../lib/attachPath';

/**
 * 已经被 CodeMirror 那条 paste 处理掉的原生事件。
 *
 * 粘贴图片同时挂了两处监听（CM 的 contentDOM + 外层 `.md-body` 的 React 兜底），
 * 为的是不赌某一种 WebView 的事件传播行为。代价是同一次粘贴可能被处理两遍，
 * 于是插两张图——用这个集合去重。WeakSet 不会拖住事件对象。
 */
const handledPastes = new WeakSet<Event>();

export interface MarkdownEditorProps {
  doc: string;
  onEdit(path: string, text: string): void;
  currentPath: string | null;
  theme: 'light' | 'dark';
  /** 移动端：工具栏置底、触控目标加大 */
  mobile?: boolean;
  /** 插图：返回要插入的相对路径（null=取消） */
  onInsertImage?: (notePath: string | null) => Promise<string | null>;
  /** 阅读模式图片解析：相对路径 → 可显示的 URL */
  resolveImage?: (rel: string) => Promise<string | null>;
  /** v0.7.0 F3：双链——点击 [[目标]] 的回调（App 负责查找/创建并跳转） */
  onOpenWiki?: (target: string) => void;
  /** v0.7.1 F6：[[ 补全候选（全部笔记标题） */
  wikiTitles?: { path: string; title: string }[];
  /** v0.7.1 F7：粘贴/拖拽图片落盘，返回要插入的相对路径 */
  onPasteImage?: (file: File, notePath: string | null) => Promise<string | null>;
  /**
   * v0.8.2 E9：锁死为阅读模式（不给切换按钮）。
   * 分栏里「同文档双视图」用它——同一个文件开两个可编辑视图会各写各的，
   * 两份防抖落盘互相覆盖就是静默丢字。所以右栏只读、跟着左栏实时重渲染。
   */
  readOnlyPreview?: boolean;
  /**
   * v0.8.4 E7：跳到某一行。带 path 是因为分栏后有两个编辑器实例——
   * 原来的 `ivnote-jump` 是全局事件，两边会一起跳。`n` 是序号，
   * 连点同一条命中行两次也要重新跳（只看 line 会被判定没变）。
   */
  jumpTo?: { path: string; line: number; n: number } | null;
  /** v0.8.6 E10：打开笔记时的初始视图（设置里可改，默认 edit＝此前的行为） */
  defaultView?: 'edit' | 'read';
  /** v0.8.6 E10：编辑态实时预览开关（默认 true＝此前的行为） */
  livePreviewOn?: boolean;
  /**
   * v0.10.0：视图模式**可受控**。移动端把「阅读/编辑」放在了顶栏，
   * 而模式状态原本只存在编辑器内部——不受控就会出现「顶栏显示编辑、
   * 编辑器其实在阅读态」这种两处不一致。
   */
  mode?: 'edit' | 'read';
  onModeChange?(m: 'edit' | 'read'): void;
  /**
   * v0.10.0：把格式化能力交出去。移动端的常驻格式条在编辑器外面
   * （底部导航之上），需要一个能按 key 施加格式的入口。
   * 组件卸载时回传 null。
   */
  exposeFormat?(apply: ((key: string) => void) | null): void;
  /**
   * v0.10.2：普通 Markdown 链接指向库内文件时的回调（已解析成库内相对路径）。
   * 不传则只处理外部链接与锚点——**外部链接必须处理**，
   * 否则 WebView 会带着整个应用导航走。
   */
  onOpenPath?(relPath: string): void;
}

function cmExtensions(
  onEdit: (text: string) => void,
  dark: boolean,
  getTitles?: () => { path: string; title: string }[],
  livePreviewOn = true,
  onFollowLink?: (href: string) => void,
  /** v0.11.0：编辑态图片解析。必须是**稳定对象**（内部走 ref），
      否则每次换文件都要重建缓存，图片会闪一下才回来 */
  imageApi?: ImageApi,
  /** v0.11.3：粘贴图片。挂在 CM 自己的 contentDOM 上，见下面的说明 */
  onPasteImageFile?: (dt: DataTransfer | null) => boolean
): Extension[] {
  return [
    ...(imageApi ? [imageResolver.of(imageApi)] : []),
    /*
     * v0.10.2：**软换行**。CM6 默认 `white-space: pre`——一段长文就是一条不换行的
     * 长线，只能横向滚。typography.css 里早写了 `.cm-line { overflow-wrap: break-word }`，
     * 但 `pre` 下那句根本不生效，所以「写了却没用」，一直没人发现漏了这个扩展。
     * 笔记软件的正文永远该按视口宽度回绕（Obsidian 也没有「不换行」这个选项）。
     */
    EditorView.lineWrapping,
    // v0.5.0 U1：Live Preview——默认隐藏行号（Obsidian 风格），装饰渲染见 livePreview.ts
    EditorView.theme({ '.cm-gutters': { display: 'none' } }),
    EditorView.theme(livePreviewTheme),
    // 关掉实时预览＝退回纯 Markdown 源码（主题留着无妨，没有装饰就不会命中）
    ...(livePreviewOn ? [livePreview] : []),
    highlightActiveLine(),
    drawSelection(),
    history(),
    indentUnit.of('    '),
    markdown(),
    // v0.10.0：**标题不要下划线**。CM6 的 defaultHighlightStyle 给 tags.heading
    // 加了 text-decoration: underline，于是每个 # 标题都像一条链接——Obsidian
    // 的标题只有字号和字重的差别。这里用自己的高亮表，深浅色共用。
    ...(dark ? [oneDark] : []),
    syntaxHighlighting(mdHighlight, { fallback: true }),
    highlightSelectionMatches(),
    // v0.7.9 E4：文内查找替换（Ctrl+F / Ctrl+H）。
    // @codemirror/search 早就装了、searchKeymap 也早就接了，但一直没显式加 search()——
    // CM6 会在首次调用时自动补配置，所以「能用」，只是面板停在默认英文、且无样式，
    // 落在这套界面里非常突兀。现在显式配置：面板置顶（跟 Obsidian 一致，不遮正文底部）。
    search({ top: true }),
    // 面板文案汉化：这些串在 @codemirror/search 里全部走 phrase()，可以整体替换
    EditorState.phrases.of({
      Find: '查找',
      Replace: '替换',
      next: '下一个',
      previous: '上一个',
      all: '全部替换',
      'match case': '区分大小写',
      'by word': '全词匹配',
      regexp: '正则',
      replace: '替换',
      'replace all': '全部替换',
      close: '关闭',
      'current match': '当前匹配',
      'Go to line': '跳转到行',
      go: '跳转',
      'on line': '行号',
    }),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    ...(getTitles ? [autocompletion({ override: [wikiCompletion(getTitles)] })] : []),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onEdit(u.state.doc.toString());
    }),
    /*
     * v0.10.2：编辑态点击链接。装饰由 livePreview 打上 `.cm-live-link` 与 data-href。
     * 用 mousedown 而不是 click：CM6 在 mousedown 就会开始设置选区，
     * 等到 click 时光标已经落进链接里、装饰随即退回源码，元素早没了。
     */
    EditorView.domEventHandlers({
      /*
       * v0.11.3：**粘贴图片挂在 CodeMirror 自己的 contentDOM 上。**
       *
       * 此前只在外层 `.md-body` 上挂了 React 的 `onPaste`——那是 React 在
       * 根容器上的委托监听，要靠事件一路冒泡上去。CM 的 contentDOM 才是粘贴真正
       * 落地的元素，在这里接是最短、最不依赖中间环节的一条路。
       * 外层那个监听保留作为兜底，靠 `handledPastes` 去重，不会插两次。
       */
      paste(e) {
        if (!onPasteImageFile || handledPastes.has(e)) return false;
        const handled = onPasteImageFile(e.clipboardData);
        if (handled) {
          handledPastes.add(e);
          e.preventDefault();
        }
        return handled;
      },
      mousedown(e) {
        if (!onFollowLink) return false;
        // 按住修饰键是「我要选文字/多光标」，不该被当成打开链接
        if (e.button !== 0 || e.altKey || e.shiftKey) return false;
        const el = (e.target as HTMLElement | null)?.closest?.('.cm-live-link');
        const href = el?.getAttribute('data-href');
        if (!href) return false;
        e.preventDefault();
        onFollowLink(href);
        return true;
      },
    }),
  ];
}

/** 渲染 Markdown 为安全 HTML（同步部分）；图片异步替换由组件完成 */
/**
 * v0.8.5 E5：把 `> [!note] …` 变成有类型的 callout。
 * marked 只会把它渲染成普通 blockquote，第一行留着字面量 `[!note]`——
 * 编辑态已经按类型上了色，阅读态却露出语法，两边对不上。
 *
 * 在**净化之后**的 HTML 上做，且只动 class 与去掉那段字面量文本，不注入任何标签。
 */
export function decorateCallouts(html: string): string {
  // `[!type] 标题` 之后到该行结束的部分是标题，剩下的是正文。
  // marked 把两者放进同一个 <p>，中间只有一个换行——不拆开就黏成一句。
  return html.replace(
    /<blockquote>\s*<p>\s*\[!([a-zA-Z]+)\]([^\n<]*)/g,
    (_m, type: string, title: string) => {
      const t = title.trim();
      const head = t ? `<span class="callout-title">${t}</span>` : '';
      return `<blockquote class="callout callout-${type.toLowerCase()}"><p>${head}`;
    }
  );
}

/**
 * 外部改动要不要灌进编辑器。
 *
 * 三种情况必须分开：
 * - `incoming === lastEmitted`：这是**我们自己**那次编辑绕了一圈回来的回声。
 *   绝不能应用——快速输入时 props 会滞后一帧，用它覆盖当前内容等于把刚敲的字吃掉。
 * - `incoming === current`：已经一致，动它只会白白挪光标。
 * - 其余：真的外部改动（同步拉取 / 撤销移动 / 模板写入），必须应用，
 *   否则屏幕停在旧内容，用户接着打字就会把远端改动覆盖掉。
 */
export function shouldApplyExternalDoc(
  incoming: string,
  current: string,
  lastEmitted: string | null
): boolean {
  return incoming !== lastEmitted && incoming !== current;
}

/*
 * v0.11.0：`==高亮==`。
 *
 * 这是 Obsidian 的写法，不是 CommonMark 也不是 GFM——marked 默认原样输出，
 * 于是编辑态（livePreview 认它）和阅读态会给出两个结果：一边是高亮，
 * 一边是四个等号。右键菜单新增了「高亮」这一项，两边就必须一致。
 * 用 marked 的 inline 扩展而不是事后正则替换 HTML：正则会连代码块里的
 * `==` 一起改掉。
 */
marked.use({
  extensions: [
    {
      name: 'ivHighlight',
      level: 'inline',
      start(src: string) {
        return src.indexOf('==');
      },
      tokenizer(src: string) {
        const m = /^==(?=\S)([\s\S]*?\S)==/.exec(src);
        if (!m) return undefined;
        return { type: 'ivHighlight', raw: m[0], text: m[1], tokens: [] };
      },
      renderer(token) {
        return `<mark>${(token as { text?: string }).text ?? ''}</mark>`;
      },
    },
  ],
});

/**
 * v0.11.10：阅读态的代码块做成一张卡片——语言名 + 复制按钮。
 *
 * marked 给出的是光秃秃的 `<pre><code class="language-js">`，靠 CSS 只能加个底色；
 * 对比 Obsidian，缺的是"这是什么语言"和"一键复制"这两件每天都要用的事。
 *
 * 和 `decorateCallouts` 一样在**净化之后**做，且只包一层自己的容器与按钮，
 * 不把任何用户内容重新塞回 HTML（语言名取自 class，已被净化器过滤过）。
 */
export function decorateCodeBlocks(html: string): string {
  return html.replace(
    /<pre><code(\s+class="language-([^"]*)")?>/g,
    (_m, _cls: string | undefined, lang: string | undefined) => {
      const name = (lang ?? '').replace(/[^a-zA-Z0-9+#._-]/g, '');
      const label = name ? `<span class="code-lang">${name}</span>` : '<span class="code-lang"></span>';
      return (
        `<div class="code-block"><div class="code-head">${label}` +
        `<button type="button" class="code-copy" title="复制代码">复制</button></div>` +
        `<pre><code${name ? ` class="language-${name}"` : ''}>`
      );
    }
  ).replace(/<\/code><\/pre>/g, '</code></pre></div>');
}

/**
 * v0.11.10：frontmatter 在阅读态渲染成「属性」区，不再当正文。
 *
 * 之前那段 `---\nstatus: doing\n---` 会被 marked 读成「分隔线 + 二级标题」——
 * 阅读一篇带属性的笔记，开头就是一条横线加一行巨大的 `status: doing`。
 * Obsidian 把它显示成文档顶部的属性面板。`.base` 视图筛的正是这些属性，
 * 现在开始会有越来越多的笔记带上它们，这条不修就会天天看见。
 *
 * 只做**显示**：不解析类型、不可编辑（编辑仍然回到源码），
 * 值原样按文本显示，转义后再拼进 HTML。
 */
export function splitFrontmatter(md: string): { props: [string, string][]; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(md);
  if (!m) return { props: [], body: md };
  const props: [string, string][] = [];
  let pendingKey: string | null = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    // `- 值`：接在上一个键后面的列表项
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && pendingKey) {
      const last = props[props.length - 1];
      last[1] = last[1] ? `${last[1]}, ${item[1]}` : item[1];
      continue;
    }
    const kv = /^([^:]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    pendingKey = kv[1].trim();
    props.push([pendingKey, kv[2].trim()]);
  }
  return { props, body: md.slice(m[0].length) };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function renderProps(props: [string, string][]): string {
  if (props.length === 0) return '';
  const rows = props
    .map(
      ([k, v]) =>
        `<div class="md-prop"><span class="md-prop-key">${escapeHtml(k)}</span>` +
        `<span class="md-prop-val">${escapeHtml(v)}</span></div>`
    )
    .join('');
  return `<div class="md-props">${rows}</div>`;
}

export function renderMarkdown(md: string): string {
  const { props, body } = splitFrontmatter(md);
  const raw = marked.parse(body, { async: false }) as string;
  return renderProps(props) + decorateCodeBlocks(decorateCallouts(DOMPurify.sanitize(raw)));
}

interface ToolBtn {
  key: string;
  /** 线性图标名。移动端与桌面共用同一套图形语言（此前是 B/I/H/•/☑/❝ 混排） */
  icon: IconName;
  title: string;
  run: (text: string, from: number, to: number) => EditResult;
}

/**
 * 编辑器语法高亮。刻意只定义少数几条：Markdown 源码本来就该看起来像正文，
 * 满屏彩色的是代码编辑器，不是笔记。
 */
const mdHighlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.url, color: 'var(--muted)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono, ui-monospace, monospace)' },
  { tag: t.quote, color: 'var(--muted)' },
  { tag: t.list, color: 'var(--muted)' },
  { tag: t.comment, color: 'var(--muted)' },
]);

const TOOLS: ToolBtn[] = [
  { key: 'b', icon: 'bold', title: '加粗', run: (t, f, to) => toggleInline(t, { from: f, to }, '**') },
  { key: 'i', icon: 'italic', title: '斜体', run: (t, f, to) => toggleInline(t, { from: f, to }, '*') },
  { key: 'h', icon: 'heading', title: '标题（循环 #/##/###）', run: (t, f, to) => cycleHeading(t, { from: f, to }) },
  { key: 'ul', icon: 'list-ul', title: '无序列表', run: (t, f, to) => toggleLinePrefix(t, { from: f, to }, '- ') },
  { key: 'ol', icon: 'list-ol', title: '有序列表', run: (t, f, to) => toggleOrderedList(t, { from: f, to }) },
  { key: 'task', icon: 'task', title: '任务列表', run: (t, f, to) => toggleTaskList(t, { from: f, to }) },
  { key: 'q', icon: 'quote', title: '引用', run: (t, f, to) => toggleLinePrefix(t, { from: f, to }, '> ') },
  { key: 'code', icon: 'code', title: '行内代码', run: (t, f, to) => toggleInline(t, { from: f, to }, '`') },
  { key: 'link', icon: 'link', title: '插入链接', run: (t, f, to) => insertLink(t, { from: f, to }) },
  // v0.11.0：右键「文本格式」里的两项。工具栏不放它们（那条已经够长），但能力得有
  { key: 'strike', icon: 'strikethrough', title: '删除线', run: (t, f, to) => toggleInline(t, { from: f, to }, '~~') },
  { key: 'mark', icon: 'highlight', title: '高亮', run: (t, f, to) => toggleInline(t, { from: f, to }, '==') },
];

export function MarkdownEditor(props: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [modeState, setModeState] = useState<'edit' | 'read'>(props.defaultView ?? 'edit');
  const mode0 = props.readOnlyPreview ? 'read' : (props.mode ?? modeState);
  const setMode = useCallback(
    (next: 'edit' | 'read' | ((m: 'edit' | 'read') => 'edit' | 'read')) => {
      const v = typeof next === 'function' ? next(mode0) : next;
      if (props.onModeChange) props.onModeChange(v);
      else setModeState(v);
    },
    // mode0 参与是为了函数式更新拿得到当前值
    [mode0, props.onModeChange] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const rootRef = useRef<HTMLDivElement>(null);
  /**
   * onEdit 走 ref 而不是直接塞进扩展。
   *
   * CodeMirror 的扩展是在建 EditorState 那一刻**固化**的：直接把 `props.onEdit`
   * 传进去，之后它的闭包就再也不更新，编辑器会一直调用当初那一个版本。
   * 于是「onEdit 依赖的东西变了」在编辑器里根本看不见——v0.8.6 的「标题跟随
   * 文件名」开关就是这么失灵的：设置里关掉了，编辑器仍在用开着的那份闭包改名。
   * （EditorState 只在 currentPath / theme 变化时重建，平时不重建。）
   */
  /**
   * 最后一次由**本编辑器自己**发出去的内容。
   * 外部 doc 变化要不要回灌进 CodeMirror，全靠它区分：
   * 等于它 = 我们自己那次编辑绕了一圈回来，不能动（否则快速输入时会用滞后
   * 一帧的 props.doc 把刚敲的字吃掉）；不等于 = 真的外部改动，必须换掉。
   */
  const lastEmitted = useRef<string | null>(null);
  const onEditRef = useRef(props.onEdit);
  const pathRef = useRef(props.currentPath);
  const onOpenPathRef = useRef(props.onOpenPath);
  useEffect(() => {
    onEditRef.current = props.onEdit;
    pathRef.current = props.currentPath;
    onOpenPathRef.current = props.onOpenPath;
  });
  const mode = mode0;

  /**
   * v0.10.2：**统一的链接跳转**。阅读态与编辑态共用这一份判定，
   * 免得两边各写一套、再各错一次（此前只有 `[[双链]]` 是通的）。
   *
   * 放在 ref 里是因为 cmExtensions 只在建实例/换文件时求值一次，
   * 直接闭包会捕获到旧的 currentPath，跨目录的相对链接就会解析错。
   */
  const followLink = useCallback(
    (href: string) => {
      const link = classifyLink(href);
      if (link.kind === 'external') {
        void openExternal(link.target);
        return;
      }
      if (link.kind === 'anchor') {
        // 阅读态：滚到同名标题；编辑态没有可滚的 DOM，忽略即可
        const host = previewRef.current;
        if (!host || !link.target) return;
        const want = headingSlug(decodeURIComponent(link.target));
        const hit = Array.from(host.querySelectorAll('h1,h2,h3,h4,h5,h6')).find(
          (h) => headingSlug(h.textContent ?? '') === want
        );
        hit?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      onOpenPathRef.current?.(resolveVaultPath(pathRef.current, link.target));
    },
    []
  );
  const followLinkRef = useRef(followLink);
  followLinkRef.current = followLink;

  /*
   * v0.11.0：**编辑态图片**。
   *
   * 装饰必须同步产出，而解析（读盘 → blob URL）是异步的，所以这里是
   * 「同步查缓存 → 缺了就去解析 → 解析完派发 imagesReadyEffect 让装饰重来一次」。
   * 缓存键带上笔记路径：相对路径是相对**这篇笔记**的，换一篇同名的
   * `img.png` 完全可能是另一张图（和阅读态用的是同一套解析规则）。
   */
  const imgCache = useRef(new Map<string, string | null>());
  const imgPending = useRef(new Set<string>());
  const resolveImageRef = useRef(props.resolveImage);
  resolveImageRef.current = props.resolveImage;
  const imageApiRef = useRef<ImageApi | null>(null);
  if (!imageApiRef.current) {
    const key = (src: string) => `${pathRef.current ?? ''}\u0000${src}`;
    imageApiRef.current = {
      get: (src) => imgCache.current.get(key(src)),
      request: (src) => {
        const k = key(src);
        if (imgPending.current.has(k)) return;
        const resolve = resolveImageRef.current;
        if (!resolve) {
          imgCache.current.set(k, null);
          return;
        }
        imgPending.current.add(k);
        void (async () => {
          let url: string | null = null;
          if (/^(https?:|data:|blob:)/.test(src)) {
            url = src;
          } else {
            // 与阅读态同一套：先按笔记自己的位置解析，再兜底老的库根相对写法
            try {
              url = await resolve(resolveVaultPath(pathRef.current, src));
            } catch {
              try {
                url = await resolve(decodeURIComponent(src));
              } catch {
                url = null;
              }
            }
          }
          imgPending.current.delete(k);
          // 缓存无上限会随着翻阅一直涨（每个 blob URL 还占着内存），够用就好
          if (imgCache.current.size > 200) imgCache.current.clear();
          imgCache.current.set(k, url ?? null);
          const v = viewRef.current;
          if (v) v.dispatch({ effects: imagesReadyEffect.of(null) });
        })();
      },
    };
  }
  const imageApi = imageApiRef.current;

  const [imgBusy, setImgBusy] = useState(false);
  /** v0.11.0：编辑区右键菜单 */
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  /** v0.7.2 移动端：选区气泡（null=隐藏；pos 为文档坐标） */
  const [bubble, setBubble] = useState<{ from: number; to: number } | null>(null);
  /** v0.7.3 P4：图片全屏预览 */
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  /** v0.7.3 P4 lightbox 打开器（阅读模式图片点击时调用） */
  const openLightbox = (src: string, alt: string) => setLightbox({ src, alt });

  // v0.7.3 P6：大纲跳转桥——MobileView 派发 ivnote-jump(offset)
  useEffect(() => {
    const onJump = (e: Event) => {
      const view = viewRef.current;
      if (!view) return;
      const offset = (e as CustomEvent<number>).detail;
      try {
        setMode('edit');
        requestAnimationFrame(() => {
          const v = viewRef.current;
          if (!v) return;
          v.dispatch({ selection: { anchor: offset }, scrollIntoView: true });
          v.focus();
        });
      } catch {
        /* offset 越界忽略 */
      }
    };
    window.addEventListener('ivnote-jump', onJump);
    return () => window.removeEventListener('ivnote-jump', onJump);
  }, []);

  /**
   * v0.8.5 E5：Ctrl+E 切换编辑 / 阅读。此前只有工具栏按钮——而这是个高频动作，
   * 各家（Obsidian / Typora）都给了快捷键。
   * 只读预览的实例不响应：它压根没有编辑态可切。
   */
  useEffect(() => {
    if (props.readOnlyPreview) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'e') return;
      const host = rootRef.current;
      if (!host) return;
      if (!host.contains(document.activeElement)) {
        // 分栏后有两个实例，谁持有焦点谁响应。
        // 但阅读态里没有任何可聚焦元素——若按「焦点在我这儿」硬判，切过去就再也
        // 切不回来了。所以：没有任何编辑器持有焦点时，交给页面上第一个可编辑实例。
        const all = [...document.querySelectorAll('.md-editor:not(.md-editor-readonly)')];
        const someoneFocused = all.some((el) => el.contains(document.activeElement));
        if (someoneFocused || all[0] !== host) return;
      }
      e.preventDefault();
      setMode((m: 'edit' | 'read') => (m === 'edit' ? 'read' : 'edit'));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.readOnlyPreview]);

  /**
   * v0.9.1：外部改动回灌。
   *
   * CodeMirror 的内容只在 `currentPath` / 主题变化时整体重建，`doc` 变了它不认。
   * 于是「另一台设备改了你正开着的这篇」时：同步确实拉下来了、磁盘上也是新的，
   * **但屏幕上还是旧的**；你接着打字，旧内容会被当成最新版写回去，
   * 直接把远端的改动覆盖掉——是丢数据，不只是显示不同步。
   *
   * 只回灌**不是自己发出去**的那些（见 lastEmitted），并尽量保住光标位置。
   */
  useEffect(() => {
    const v = viewRef.current;
    // state 取不到就当没这回事：编辑器坏掉不该连累整页渲染（jsdom 里的桩也走这条）
    if (!v?.state?.doc || mode !== 'edit') return;
    const incoming = props.doc ?? '';
    const cur = v.state.doc.toString();
    if (!shouldApplyExternalDoc(incoming, cur, lastEmitted.current)) return;
    const anchor = Math.min(v.state.selection.main.head, incoming.length);
    v.dispatch({
      changes: { from: 0, to: cur.length, insert: incoming },
      selection: { anchor },
    });
    lastEmitted.current = incoming;
  }, [props.doc, mode]);

  // v0.8.4 E7：跳到指定行（只有显示着那个文件的实例才响应）
  useEffect(() => {
    const j = props.jumpTo;
    if (!j || j.path !== props.currentPath) return;
    setMode('edit');
    requestAnimationFrame(() => {
      const v = viewRef.current;
      if (!v) return;
      const lineNo = Math.min(Math.max(1, j.line), v.state.doc.lines);
      const pos = v.state.doc.line(lineNo).from;
      v.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      v.focus();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.jumpTo, props.currentPath]);

  // 创建 CodeMirror 实例（一次）
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: '',
        extensions: cmExtensions(
          () => undefined,
          props.theme === 'dark',
          () => props.wikiTitles ?? [],
          props.livePreviewOn ?? true,
          (href) => followLinkRef.current(href),
          imageApi,
          (dt) => {
            const f = pasteHookRef.current.pick(dt);
            if (!f) return false;
            pasteHookRef.current.insert(f);
            return true;
          }
        ),
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切换文件/主题时重建编辑器状态
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.setState(
      EditorState.create({
        doc: props.doc ?? '',
        extensions: cmExtensions(
          (text: string) => {
            lastEmitted.current = text;
            onEditRef.current(pathRef.current ?? '', text);
          },
          props.theme === 'dark',
          () => props.wikiTitles ?? [],
          props.livePreviewOn ?? true,
          (href) => followLinkRef.current(href),
          imageApi,
          (dt) => {
            const f = pasteHookRef.current.pick(dt);
            if (!f) return false;
            pasteHookRef.current.insert(f);
            return true;
          }
        ),
      })
    );
    setBubble(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.currentPath, props.theme, props.livePreviewOn]);

  // 阅读模式：渲染 + 异步替换图片 + 活预览（v0.7.3 P4）
  useEffect(() => {
    if (mode !== 'read') return;
    const el = previewRef.current;
    if (!el) return;
    let html = renderMarkdown(props.doc ?? '');
    html = renderWikiLinks(html, (t) => `#/wiki/${encodeURIComponent(t)}`);
    el.innerHTML = html;

    // v0.7.3 P4a：任务列表 checkbox 变为可交互——点击回写源码
    // marked 把 `- [ ]` 渲染成 <input type="checkbox" disabled>；按文档顺序映射回源码行
    const checkboxes = Array.from(el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    if (checkboxes.length > 0 && props.doc) {
      const lines = (props.doc ?? '').split('\n');
      const taskLines: number[] = [];
      lines.forEach((ln, i) => {
        if (/^\s*([-*+])\s+\[( |x|X)\]\s+/.test(ln)) taskLines.push(i);
      });
      checkboxes.forEach((cb, idx) => {
        cb.disabled = false;
        cb.removeAttribute('disabled');
        const lineNo = taskLines[idx];
        cb.addEventListener('change', () => {
          if (lineNo == null || !props.onEdit || !props.currentPath) return;
          const m = lines[lineNo].match(/^(\s*([-*+])\s+)\[( |x|X)\]/);
          if (!m) return;
          const replaced = lines[lineNo].replace(
            /^(\s*([-*+])\s+)\[( |x|X)\]/,
            (_all, pre: string) => `${pre}[${cb.checked ? 'x' : ' '}]`
          );
          lines[lineNo] = replaced;
          props.onEdit(props.currentPath!, lines.join('\n'));
          // 勾选状态保留（下一轮 effect 重新渲染时会以新 doc 校准）
        });
      });
    }

    /*
     * v0.11.10：代码块的「复制」。委托在容器上，重渲染不会丢监听。
     */
    const onCopyClick = (ev: Event) => {
      const btn = (ev.target as HTMLElement | null)?.closest?.('button.code-copy');
      if (!btn) return;
      const code = btn.closest('.code-block')?.querySelector('code');
      if (!code) return;
      ev.preventDefault();
      void navigator.clipboard?.writeText(code.textContent ?? '').then(
        () => {
          btn.textContent = '已复制';
          setTimeout(() => {
            btn.textContent = '复制';
          }, 1200);
        },
        () => {
          btn.textContent = '复制失败';
          setTimeout(() => {
            btn.textContent = '复制';
          }, 1200);
        }
      );
    };
    el.addEventListener('click', onCopyClick);

    /*
     * v0.10.2：**所有** <a> 的点击都在这里接管，一个事件委托搞定。
     *
     * 此前只给 `a.wikilink` 逐个绑了 click，于是普通 `[文字](https://…)`
     * 完全没人管——WebView 会带着整个应用导航到那个地址（白屏，只能重启）。
     * 委托到容器上还有个好处：图片异步替换、任务勾选重渲染都不会把监听丢掉。
     */
    const onLinkClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.('a');
      if (!a || !el.contains(a)) return;
      e.preventDefault();
      const wiki = (a as HTMLElement).dataset.target;
      if (a.classList.contains('wikilink')) {
        if (wiki) props.onOpenWiki?.(wiki);
        return;
      }
      const href = a.getAttribute('href');
      if (href) followLinkRef.current(href);
    };
    el.addEventListener('click', onLinkClick);

    if (!props.resolveImage)
      return () => {
        el.removeEventListener('click', onLinkClick);
        el.removeEventListener('click', onCopyClick);
      };
    let cancelled = false;
    const imgs = Array.from(el.querySelectorAll('img'));
    void (async () => {
      for (const img of imgs) {
        const src = img.getAttribute('src') ?? '';
        // 右键菜单要拿库内路径，而 src 待会儿就被换成 blob URL 了
        img.dataset.src = src;
        if (/^(https?:|data:|blob:)/.test(src)) continue;
        /*
         * v0.10.7：**按笔记自己的位置解析**，而不是拿库根去拼。
         *
         * Markdown 里的相对路径本来就是相对文件自己的，`<a href>` 那条路
         * 早就走 `resolveVaultPath` 了，图片这条却一直漏着 —— 于是写入侧
         * 写库根相对、读取侧也读库根相对，两头一起错、自洽，但只在这个应用里自洽。
         * 第二次尝试是给 v0.10.6 及以前存量笔记的兜底：那些确实是库根相对。
         */
        const noteRel = resolveVaultPath(props.currentPath, src);
        let url: string | null = null;
        try {
          url = await props.resolveImage!(noteRel);
        } catch {
          try {
            url = await props.resolveImage!(decodeURIComponent(src));
          } catch {
            url = null;
          }
        }
        if (cancelled) break;
        if (url) img.src = url;
        else img.alt = `${img.alt}（图片加载失败：${src}）`;
      }
      // v0.7.3 P4b：图片点击全屏预览（轻量 lightbox，点任意处关闭）
      if (cancelled) return;
      imgs.forEach((img) => {
        img.style.cursor = 'zoom-in';
        img.addEventListener('click', (e) => {
          e.stopPropagation();
          openLightbox(img.src, img.alt);
        });
      });
    })();
    return () => {
      cancelled = true;
      el.removeEventListener('click', onLinkClick);
      el.removeEventListener('click', onCopyClick);
    };
  }, [mode, props.doc, props.resolveImage, props.currentPath]);

  /**
   * 粘贴 / 拖入图片 → 落盘 → 在光标处插入引用（v0.7.1 F7；v0.11.3 大改）。
   *
   * ⚠️ 这个函数此前有**三条静默 return 加一个静默 catch**：没有 onPasteImage、
   * 不是图片、没有当前笔记、落盘抛异常——四种情况用户看到的都是"什么都没发生"。
   * 于是「粘贴图片没反应」连报了四轮，而每一轮都拿不到任何线索。
   * 现在每一条失败路径都必须说话：说不出原因的失败等于没修过。
   */
  const insertDroppedImage = async (file: File, insertAt?: number) => {
    if (!props.onPasteImage) {
      raiseToast('这个视图不支持插入图片', 'error');
      return;
    }
    if (!file.type.startsWith('image/')) {
      raiseToast(`剪贴板里的不是图片（${file.type || '未知类型'}）`, 'error');
      return;
    }
    if (!props.currentPath) {
      raiseToast('先打开或新建一篇笔记，图片才知道该存到哪', 'error');
      return;
    }
    const view = viewRef.current;
    if (!view) return;
    try {
      const rel = await props.onPasteImage(file, props.currentPath);
      if (!rel) {
        raiseToast('图片没能存进笔记库（可能是没有写入权限）', 'error');
        return;
      }
      const pos = insertAt ?? view.state.selection.main.from;
      // 写进正文的必须是**相对这篇笔记**的路径，rel 是库内路径
      const text = `![](${encodeHref(noteRelative(props.currentPath, rel))})`;
      view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length } });
      view.focus();
    } catch (e) {
      raiseToast(`插入图片失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  /**
   * 从一次剪贴板/拖放事件里取出图片文件。
   *
   * **两个来源都要看**：`items` 是 Chromium 的常规通道，但某些 WebView 只填 `files`。
   * 这个应用跑在三种 WebView 上（WebView2 / webkit2gtk / 安卓 WebView），
   * 只认一条通道就等于赌另外两个恰好也这么做。
   */
  const imageFromTransfer = (dt: DataTransfer | null): File | null => {
    if (!dt) return null;
    for (const f of Array.from(dt.files ?? [])) {
      if (f.type.startsWith('image/')) return f;
    }
    for (const it of Array.from(dt.items ?? [])) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) return f;
      }
    }
    return null;
  };
  const pasteHookRef = useRef<{ pick(dt: DataTransfer | null): File | null; insert(f: File): void }>({
    pick: imageFromTransfer,
    insert: () => undefined,
  });
  pasteHookRef.current = {
    pick: imageFromTransfer,
    insert: (f: File) => void insertDroppedImage(f),
  };

  /**
   * 主动读剪贴板里的图片（右键「插入 → 剪贴板里的图片」）。
   *
   * 存在的理由：粘贴事件那条路依赖 WebView 把系统剪贴板里的位图转成 `image/png`
   * 塞进 ClipboardEvent，各家 WebView 行为并不一致。这条路绕开事件直接问剪贴板要——
   * 粘贴键失灵时它仍然能用，而且失败原因说得出来。
   */
  const insertClipboardImage = async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const type = it.types.find((t) => t.startsWith('image/'));
        if (!type) continue;
        const blob = await it.getType(type);
        const ext = type.split('/')[1]?.split('+')[0] || 'png';
        await insertDroppedImage(new File([blob], `clipboard.${ext}`, { type }));
        return;
      }
      raiseToast('剪贴板里没有图片', 'error');
    } catch (e) {
      raiseToast(`读不到剪贴板：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  /** v0.7.2 移动端：非空选区时显示气泡（在选区上方浮出），折叠选区时隐藏 */
  const [bubblePos, setBubblePos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!props.mobile) return;
    const view = viewRef.current;
    if (!view) return;
    const update = () => {
      if (mode !== 'edit') {
        setBubble(null);
        setBubblePos(null);
        return;
      }
      const { from, to } = view.state.selection.main;
      if (from === to || view.state.readOnly) {
        setBubble(null);
        setBubblePos(null);
        return;
      }
      setBubble({ from, to });
      try {
        const c1 = view.coordsAtPos(from);
        const c2 = view.coordsAtPos(to);
        const hostRect = view.dom.getBoundingClientRect();
        if (c1 && c2) {
          const x1 = Math.min(c1.left, c2.left) - hostRect.left;
          const x2 = Math.max(c1.right, c2.right) - hostRect.left;
          const yTop = Math.min(c1.top, c2.top) - hostRect.top;
          setBubblePos({ left: (x1 + x2) / 2, top: yTop });
        }
      } catch {
        /* 视口外坐标暂不可得，仅隐藏定位 */
        setBubblePos(null);
      }
    };
    update();
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, [props.mobile, props.currentPath, mode]);

  /**
   * v0.8.6 E10：换一篇笔记时回到「打开笔记时」设定的视图。
   * 不这么做的话，用户在某篇里切到阅读态，之后每一篇都停在阅读态——
   * 那不是「默认视图」，那是粘住了。
   */
  useEffect(() => {
    if (props.readOnlyPreview) return;
    setMode(props.defaultView ?? 'edit');
  }, [props.currentPath, props.defaultView, props.readOnlyPreview]);

  /** 气泡按钮应用格式后刷新自身状态（选区被重设为选中文本） */
  const bubbleFormat = (btn: ToolBtn) => {
    applyFormat(btn);
    // dispatch 后下一帧重新读取选区/坐标
    requestAnimationFrame(() => {
      const view = viewRef.current;
      if (!view) return;
      const { from, to } = view.state.selection.main;
      if (from === to) {
        setBubble(null);
        setBubblePos(null);
        return;
      }
      setBubble({ from, to });
      try {
        const c1 = view.coordsAtPos(from);
        const c2 = view.coordsAtPos(to);
        const hostRect = view.dom.getBoundingClientRect();
        if (c1 && c2) {
          const x1 = Math.min(c1.left, c2.left) - hostRect.left;
          const x2 = Math.max(c1.right, c2.right) - hostRect.left;
          const yTop = Math.min(c1.top, c2.top) - hostRect.top;
          setBubblePos({ left: (x1 + x2) / 2, top: yTop });
        }
      } catch {
        setBubblePos(null);
      }
    });
  };

  /** 对编辑器当前选区应用格式命令 */
  const applyFormat = (btn: ToolBtn) => {
    const view = viewRef.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const text = view.state.doc.toString();
    const r = btn.run(text, from, to);
    view.dispatch({
      changes: { from: 0, to: text.length, insert: r.text },
      selection: { anchor: r.sel.from, head: r.sel.to },
      scrollIntoView: true,
    });
    view.focus();
  };

  /**
   * v0.10.0：把「按 key 施加格式」交给外面（移动端底部格式条在编辑器之外）。
   * 用 ref 转发而不是每次渲染都回调一个新函数——后者会让消费方的 effect 反复触发。
   */
  // 插图的实现定义在后面，用 holder 转发避免 TDZ
  const insertImageHolder = useRef<(() => Promise<void>) | null>(null);
  const applyRef = useRef(applyFormat);
  applyRef.current = applyFormat;

  const { exposeFormat } = props;
  useEffect(() => {
    if (!exposeFormat) return;
    exposeFormat((key: string) => {
      if (key === 'image') {
        void insertImageHolder.current?.();
        return;
      }
      const btn = TOOLS.find((t) => t.key === key);
      if (btn) applyRef.current(btn);
    });
    return () => exposeFormat(null);
  }, [exposeFormat]);

  const doInsertImage = async () => {
    if (!props.onInsertImage || imgBusy) return;
    setImgBusy(true);
    try {
      const rel = await props.onInsertImage(props.currentPath);
      if (!rel) return;
      const view = viewRef.current;
      if (!view) return;
      const { from, to } = view.state.selection.main;
      const text = view.state.doc.toString();
      const r = insertImage(text, { from, to }, rel, encodeHref(noteRelative(props.currentPath, rel)));
      view.dispatch({
        changes: { from: 0, to: text.length, insert: r.text },
        selection: { anchor: r.sel.from, head: r.sel.to },
      });
      view.focus();
    } finally {
      setImgBusy(false);
    }
  };
  insertImageHolder.current = doInsertImage;

  /* ------------------------------------------------------------------
   * v0.11.0：编辑区右键菜单。
   *
   * 用户原话：「在文档页面的鼠标右键功能也是少的可怜，还是说本来就没有右键的功能」——
   * 是后者。`onContextMenu` 此前只绑在文件树上，编辑区弹的是 WebView 自带的那几项。
   * 菜单**内容**在 lib/editorMenu.ts（纯函数、可单测），这里只负责：
   * 收集上下文 → 执行动作 → 画出来。
   * ------------------------------------------------------------------ */

  /** 对文档做一次纯函数变换并写回（右键菜单里所有改文档的项都走这里） */
  const applyEdit = (fn: (text: string, from: number, to: number) => EditResult) => {
    const view = viewRef.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const text = view.state.doc.toString();
    const r = fn(text, from, to);
    view.dispatch({
      changes: { from: 0, to: text.length, insert: r.text },
      selection: { anchor: r.sel.from, head: r.sel.to },
      scrollIntoView: true,
    });
    view.focus();
  };

  /** 剥掉行内 Markdown 标记——「以纯文本形式粘贴」用 */
  const stripMd = (s: string) =>
    s
      .replace(/!\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')
      .replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/~~([^~\n]+)~~/g, '$1')
      .replace(/==([^=\n]+)==/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*([^*\n]+)\*/g, '$1')
      .replace(/^\s*(#{1,6}\s+|>\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+)/gm, '');

  const writeClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      raiseToast('复制失败：系统剪贴板不可用，请用 Ctrl+C', 'error');
      return false;
    }
  };

  /**
   * 读剪贴板。
   *
   * 不用 `document.execCommand('paste')`——它在任何现代 WebView 里都是禁用的。
   * `navigator.clipboard.readText()` 在 WebView2 里可用，但**可能被拒**（策略/无焦点），
   * 那时必须说出来：静默什么都不发生，用户只会以为「粘贴坏了」。
   */
  const readClipboard = async (): Promise<string | null> => {
    try {
      return await navigator.clipboard.readText();
    } catch {
      raiseToast('读不到剪贴板内容，请直接用 Ctrl+V 粘贴', 'error');
      return null;
    }
  };

  const openEditorMenu = (e: React.MouseEvent) => {
    // 阅读态、以及只读预览栏也该有菜单（至少能复制、能打开链接）
    const target = e.target as HTMLElement | null;
    const view = viewRef.current;
    e.preventDefault();

    // 右键落在没有选区的位置时，先把光标挪过去——不然「加粗」会作用在别处
    if (view && mode === 'edit' && view.state.selection.main.empty) {
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos != null) view.dispatch({ selection: { anchor: pos } });
    }

    const linkEl = target?.closest?.('.cm-live-link, a') as HTMLElement | null;
    const linkHref = linkEl?.getAttribute('data-href') ?? linkEl?.getAttribute('href') ?? null;
    const imgEl = target?.closest?.('img') as HTMLImageElement | null;
    const imageSrc = imgEl?.dataset.src ?? null;

    const sel = view?.state.selection.main;
    const hasSelection =
      mode === 'read'
        ? !(window.getSelection()?.isCollapsed ?? true)
        : !!sel && !sel.empty;

    const readOnly = mode === 'read' || !!props.readOnlyPreview;

    const items = buildEditorMenu(
      {
        hasSelection,
        linkHref,
        imageSrc,
        canInsertImage: !!props.onInsertImage && !!props.currentPath,
        readOnly,
      },
      {
        format: (key) => {
          const btn = TOOLS.find((b) => b.key === key);
          if (btn) applyEdit(btn.run);
        },
        heading: (level) => applyEdit((t, f, to) => setHeading(t, { from: f, to }, level)),
        insertBlock: (kind) => {
          const snip = blockSnippet(kind);
          if (kind === 'date' || kind === 'time') {
            applyEdit((t, f, to) => insertText(t, { from: f, to }, snip.text));
          } else {
            applyEdit((t, f, to) => insertBlock(t, { from: f, to }, snip.text, snip.caret));
          }
        },
        insertImage: () => void doInsertImage(),
        insertClipboardImage: () => void insertClipboardImage(),
        link: () => applyEdit((t, f, to) => insertWikiLink(t, { from: f, to })),
        externalLink: () => applyEdit((t, f, to) => insertLink(t, { from: f, to })),
        clearFormat: () => applyEdit((t, f, to) => clearFormatting(t, { from: f, to })),
        cut: () => {
          const v = viewRef.current;
          if (!v) return;
          const { from, to } = v.state.selection.main;
          const text = v.state.sliceDoc(from, to);
          void writeClipboard(text).then((ok) => {
            if (!ok) return;
            v.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: from } });
            v.focus();
          });
        },
        copy: () => {
          if (mode === 'read') {
            void writeClipboard(window.getSelection()?.toString() ?? '');
            return;
          }
          const v = viewRef.current;
          if (!v) return;
          const { from, to } = v.state.selection.main;
          void writeClipboard(v.state.sliceDoc(from, to));
        },
        paste: () => {
          void readClipboard().then((text) => {
            if (text == null) return;
            applyEdit((t, f, to) => insertText(t, { from: f, to }, text));
          });
        },
        pastePlain: () => {
          void readClipboard().then((text) => {
            if (text == null) return;
            applyEdit((t, f, to) => insertText(t, { from: f, to }, stripMd(text)));
          });
        },
        selectAll: () => {
          const v = viewRef.current;
          if (mode === 'read') {
            const host = previewRef.current;
            if (!host) return;
            const range = document.createRange();
            range.selectNodeContents(host);
            const s = window.getSelection();
            s?.removeAllRanges();
            s?.addRange(range);
            return;
          }
          if (!v) return;
          v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
          v.focus();
        },
        openLink: (href) => followLinkRef.current(href),
        copyToClipboard: (text) => void writeClipboard(text),
      }
    );
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  /* 常驻格式条已不在编辑器内部：桌面端不要（Obsidian 也没有），
     移动端由 MobileView 的底部栏统一拥有。选区气泡仍保留。 */

  return (
    <div
      className={`md-editor ${props.mobile ? 'md-editor-mobile' : ''}${
        props.readOnlyPreview ? ' md-editor-readonly' : ''
      }`}
      ref={rootRef}
    >
      {/*
        v0.10.0：**桌面端不再有常驻格式工具栏**。
        Obsidian 的编辑区上方只有标签页，然后直接是正文——那条 B/I/H 横条是
        「通用 Markdown 编辑器」的标志，摆在这儿会让整个界面掉出 Obsidian 那一类。
        格式化仍然齐全，走快捷键与命令面板；移动端另有底部常驻格式条（那是
        Obsidian 移动端也有的）。
      */}
      {/*
        v0.10.0：移动端的工具条**不再由编辑器自己渲染**。
        它现在是 MobileView 底部常驻栏的一部分（导航之上、可展开），
        编辑器只负责通过 exposeFormat 把「施加格式」这件事交出去。
        否则会出现两条格式条上下打架——刚好是这次改到一半时的样子。
      */}
      <div
        className="md-body"
        /* v0.11.0：编辑区右键菜单。WebView 自带的那张只有三四项，必须挡掉 */
        onContextMenu={openEditorMenu}
        /* 兜底：CM 的 contentDOM 那条没接住时（某些 WebView 的事件传播不一样）
           还有这一层。handledPastes 保证同一次粘贴不会插两张图 */
        onPaste={(e) => {
          if (handledPastes.has(e.nativeEvent)) return;
          const f = imageFromTransfer(e.clipboardData);
          if (!f) return;
          e.preventDefault();
          handledPastes.add(e.nativeEvent);
          void insertDroppedImage(f);
        }}
        onDrop={(e) => {
          const f = imageFromTransfer(e.dataTransfer);
          if (f) {
            e.preventDefault();
            const view = viewRef.current;
            const pos = view?.posAtCoords({ x: e.clientX, y: e.clientY }) ?? undefined;
            void insertDroppedImage(f, pos);
          }
        }}
      >
        <div className="editor-host" ref={hostRef} style={{ display: mode === 'edit' ? undefined : 'none' }} />
        {mode === 'read' && <div className="md-preview" ref={previewRef} />}
      </div>
      {/* v0.7.2 移动端：选区浮动气泡（替代常驻横条） */}
      {props.mobile && bubble && bubblePos && mode === 'edit' && (
        <div
          className="md-bubble"
          role="toolbar"
          aria-label="格式工具"
          style={{ left: bubblePos.left, top: bubblePos.top }}
        >
          {TOOLS.filter((b) => ['b', 'i', 'h', 'ul', 'task', 'q', 'code', 'link'].includes(b.key)).map((b) => (
            <button
              key={b.key}
              className={`md-tool ${b.key === 'b' ? 't-bold' : b.key === 'i' ? 't-italic' : ''}`}
              title={b.title}
              aria-label={b.title}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => bubbleFormat(b)}
            >
              <RibbonIcon name={b.icon} size={17} />
            </button>
          ))}
        </div>
      )}
      <ContextMenu anchor={menu} onClose={() => setMenu(null)} />
      {/* v0.7.3 P4：图片全屏预览 */}
      {lightbox && (
        <div className="m-img-viewer" onClick={() => setLightbox(null)}>
          <img src={lightbox.src} alt={lightbox.alt} />
        </div>
      )}
    </div>
  );
}

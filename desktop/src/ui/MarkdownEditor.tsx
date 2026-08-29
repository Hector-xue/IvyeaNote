/**
 * MarkdownEditor（v0.3.4）：桌面/移动共用的编辑器组件。
 * - CodeMirror 6 内核（Obsidian 同款），移动端不再用裸 textarea
 * - 格式化工具栏：加粗/斜体/标题/列表/引用/代码/链接/插图（桌面顶部、移动底部）
 * - 阅读模式：marked + DOMPurify 渲染，图片按相对路径真实显示
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  highlightActiveLine,
  drawSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, indentUnit } from '@codemirror/language';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import {
  cycleHeading,
  insertImage,
  insertLink,
  toggleInline,
  toggleLinePrefix,
  toggleOrderedList,
  toggleTaskList,
  type EditResult,
} from '../lib/format';
import { livePreview, livePreviewTheme } from '../lib/livePreview';
import { autocompletion } from '@codemirror/autocomplete';
import { wikiCompletion } from '../lib/wikiComplete';
import { renderWikiLinks } from '../lib/wikilink';

export interface MarkdownEditorProps {
  doc: string;
  onEdit(path: string, text: string): void;
  currentPath: string | null;
  theme: 'light' | 'dark';
  /** 移动端：工具栏置底、触控目标加大 */
  mobile?: boolean;
  /** 插图：返回要插入的相对路径（null=取消） */
  onInsertImage?: () => Promise<string | null>;
  /** 阅读模式图片解析：相对路径 → 可显示的 URL */
  resolveImage?: (rel: string) => Promise<string | null>;
  /** v0.7.0 F3：双链——点击 [[目标]] 的回调（App 负责查找/创建并跳转） */
  onOpenWiki?: (target: string) => void;
  /** v0.7.1 F6：[[ 补全候选（全部笔记标题） */
  wikiTitles?: { path: string; title: string }[];
  /** v0.7.1 F7：粘贴/拖拽图片落盘，返回要插入的相对路径 */
  onPasteImage?: (file: File) => Promise<string | null>;
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
}

function cmExtensions(
  onEdit: (text: string) => void,
  dark: boolean,
  getTitles?: () => { path: string; title: string }[],
  livePreviewOn = true
): Extension[] {
  return [
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
    ...(dark ? [oneDark] : [syntaxHighlighting(defaultHighlightStyle, { fallback: true })]),
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
  return html.replace(
    /<blockquote>\s*<p>\s*\[!([a-zA-Z]+)\]\s*/g,
    (_m, type: string) => `<blockquote class="callout callout-${type.toLowerCase()}"><p>`
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

export function renderMarkdown(md: string): string {
  const raw = marked.parse(md, { async: false }) as string;
  return decorateCallouts(DOMPurify.sanitize(raw));
}

interface ToolBtn {
  key: string;
  label: string;
  title: string;
  run: (text: string, from: number, to: number) => EditResult;
}

const TOOLS: ToolBtn[] = [
  { key: 'b', label: 'B', title: '加粗', run: (t, f, to) => toggleInline(t, { from: f, to }, '**') },
  { key: 'i', label: 'I', title: '斜体', run: (t, f, to) => toggleInline(t, { from: f, to }, '*') },
  { key: 'h', label: 'H', title: '标题（循环 #/##/###）', run: (t, f, to) => cycleHeading(t, { from: f, to }) },
  { key: 'ul', label: '•', title: '无序列表', run: (t, f, to) => toggleLinePrefix(t, { from: f, to }, '- ') },
  { key: 'ol', label: '1.', title: '有序列表', run: (t, f, to) => toggleOrderedList(t, { from: f, to }) },
  { key: 'task', label: '☑', title: '任务列表', run: (t, f, to) => toggleTaskList(t, { from: f, to }) },
  { key: 'q', label: '❝', title: '引用', run: (t, f, to) => toggleLinePrefix(t, { from: f, to }, '> ') },
  { key: 'code', label: '</>', title: '行内代码', run: (t, f, to) => toggleInline(t, { from: f, to }, '`') },
  { key: 'link', label: '🔗', title: '插入链接', run: (t, f, to) => insertLink(t, { from: f, to }) },
];

export function MarkdownEditor(props: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [modeState, setMode] = useState<'edit' | 'read'>(props.defaultView ?? 'edit');
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
  useEffect(() => {
    onEditRef.current = props.onEdit;
    pathRef.current = props.currentPath;
  });
  const mode = props.readOnlyPreview ? 'read' : modeState;
  const [imgBusy, setImgBusy] = useState(false);
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
      setMode((m) => (m === 'edit' ? 'read' : 'edit'));
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
          props.livePreviewOn ?? true
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
          props.livePreviewOn ?? true
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

    // 双链点击（事件委托）
    el.querySelectorAll('a.wikilink').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const t = (a as HTMLElement).dataset.target;
        if (t) props.onOpenWiki?.(t);
      });
    });

    if (!props.resolveImage) return;
    let cancelled = false;
    const imgs = Array.from(el.querySelectorAll('img'));
    void (async () => {
      for (const img of imgs) {
        const src = img.getAttribute('src') ?? '';
        if (/^(https?:|data:|blob:)/.test(src)) continue;
        try {
          const url = await props.resolveImage!(decodeURIComponent(src));
          if (!cancelled && url) img.src = url;
        } catch {
          img.alt = `${img.alt}（图片加载失败）`;
        }
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
    };
  }, [mode, props.doc, props.resolveImage]);

  /** v0.7.1 F7：粘贴/拖入图片 → 落盘 Attachments/ → 在光标处插入引用 */
  const insertDroppedImage = async (file: File, insertAt?: number) => {
    if (!props.onPasteImage || !file.type.startsWith('image/')) return;
    const view = viewRef.current;
    try {
      const rel = await props.onPasteImage(file);
      if (!rel || !view) return;
      const pos = insertAt ?? view.state.selection.main.from;
      const text = `![](${rel})`;
      view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length } });
      view.focus();
    } catch {
      // 静默：粘贴普通文本不受影响
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

  const doInsertImage = async () => {
    if (!props.onInsertImage || imgBusy) return;
    setImgBusy(true);
    try {
      const rel = await props.onInsertImage();
      if (!rel) return;
      const view = viewRef.current;
      if (!view) return;
      const { from, to } = view.state.selection.main;
      const text = view.state.doc.toString();
      const r = insertImage(text, { from, to }, rel);
      view.dispatch({
        changes: { from: 0, to: text.length, insert: r.text },
        selection: { anchor: r.sel.from, head: r.sel.to },
      });
      view.focus();
    } finally {
      setImgBusy(false);
    }
  };

  const toolbar = useMemo(
    () => (
      <div className={`md-toolbar ${props.mobile ? 'md-toolbar-bottom' : ''}`}>
        {TOOLS.map((b) => (
          <button
            key={b.key}
            className={`md-tool ${b.key === 'b' ? 't-bold' : b.key === 'i' ? 't-italic' : ''}`}
            title={b.title}
            aria-label={b.title}
            // 移动端用 onClick 即可；preventDefault 防止按钮抢焦点导致选区丢失
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => applyFormat(b)}
          >
            {b.label}
          </button>
        ))}
        {props.onInsertImage && (
          <button
            className="md-tool"
            title="插入图片"
            aria-label="插入图片"
            onPointerDown={(e) => e.preventDefault()}
            disabled={imgBusy}
            onClick={() => void doInsertImage()}
          >
            🖼
          </button>
        )}
        <span className="md-toolbar-spacer" />
        <button
          className={`md-tool md-mode ${mode === 'read' ? 'active' : ''}`}
          hidden={props.readOnlyPreview}
          title={mode === 'edit' ? '切换到阅读模式' : '切换到编辑模式'}
          aria-label="切换编辑/阅读"
          onClick={() => setMode(mode === 'edit' ? 'read' : 'edit')}
        >
          {mode === 'edit' ? '👁' : '✎'}
        </button>
      </div>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, imgBusy, props.mobile, props.onInsertImage]
  );

  return (
    <div
      className={`md-editor ${props.mobile ? 'md-editor-mobile' : ''}${
        props.readOnlyPreview ? ' md-editor-readonly' : ''
      }`}
      ref={rootRef}
    >
      {/* 只读预览没有可编辑的编辑器，整条格式工具栏点了都不会有反应，直接不给 */}
      {!props.mobile && !props.readOnlyPreview && toolbar}
      <div
        className="md-body"
        onPaste={(e) => {
          const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'));
          if (item) {
            const f = item.getAsFile();
            if (f) {
              e.preventDefault();
              void insertDroppedImage(f);
            }
          }
        }}
        onDrop={(e) => {
          const f = Array.from(e.dataTransfer?.files ?? []).find((i) => i.type.startsWith('image/'));
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
              {b.label}
            </button>
          ))}
        </div>
      )}
      {props.mobile && (
        <div className="md-insert-bar">
          <button
            className="md-tool"
            title="插入图片"
            aria-label="插入图片"
            onPointerDown={(e) => e.preventDefault()}
            disabled={imgBusy}
            onClick={() => void doInsertImage()}
          >
            🖼
          </button>
          <span className="md-toolbar-spacer" />
          <button
            className={`md-tool md-mode ${mode === 'read' ? 'active' : ''}`}
            hidden={props.readOnlyPreview}
            title={mode === 'edit' ? '切换到阅读模式' : '切换到编辑模式'}
            aria-label="切换编辑/阅读"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => setMode(mode === 'edit' ? 'read' : 'edit')}
          >
            {mode === 'edit' ? '👁' : '✎'}
          </button>
        </div>
      )}
      {/* v0.7.3 P4：图片全屏预览 */}
      {lightbox && (
        <div className="m-img-viewer" onClick={() => setLightbox(null)}>
          <img src={lightbox.src} alt={lightbox.alt} />
        </div>
      )}
    </div>
  );
}

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
}

function cmExtensions(
  onEdit: (text: string) => void,
  dark: boolean,
  getTitles?: () => { path: string; title: string }[]
): Extension[] {
  return [
    // v0.5.0 U1：Live Preview——默认隐藏行号（Obsidian 风格），装饰渲染见 livePreview.ts
    EditorView.theme({ '.cm-gutters': { display: 'none' } }),
    EditorView.theme(livePreviewTheme),
    livePreview,
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
export function renderMarkdown(md: string): string {
  const raw = marked.parse(md, { async: false }) as string;
  return DOMPurify.sanitize(raw);
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
  const [mode, setMode] = useState<'edit' | 'read'>('edit');
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

  // 创建 CodeMirror 实例（一次）
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: '', extensions: cmExtensions(() => undefined, props.theme === 'dark', () => props.wikiTitles ?? []) }),
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
        extensions: cmExtensions(props.onEdit.bind(null, props.currentPath ?? ''), props.theme === 'dark', () => props.wikiTitles ?? []),
      })
    );
    setBubble(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.currentPath, props.theme]);

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
    <div className={`md-editor ${props.mobile ? 'md-editor-mobile' : ''}`}>
      {!props.mobile && toolbar}
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

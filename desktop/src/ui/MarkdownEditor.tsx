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
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
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
}

function cmExtensions(onEdit: (text: string) => void, dark: boolean): Extension[] {
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
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
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

  // 创建 CodeMirror 实例（一次）
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: '', extensions: cmExtensions(() => undefined, props.theme === 'dark') }),
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
        extensions: cmExtensions(props.onEdit.bind(null, props.currentPath ?? ''), props.theme === 'dark'),
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.currentPath, props.theme]);

  // 阅读模式：渲染 + 异步替换图片
  useEffect(() => {
    if (mode !== 'read') return;
    const el = previewRef.current;
    if (!el) return;
    el.innerHTML = renderMarkdown(props.doc ?? '');
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
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, props.doc, props.resolveImage]);

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
      <div className="md-body">
        <div className="editor-host" ref={hostRef} style={{ display: mode === 'edit' ? undefined : 'none' }} />
        {mode === 'read' && <div className="md-preview" ref={previewRef} />}
      </div>
      {props.mobile && toolbar}
    </div>
  );
}

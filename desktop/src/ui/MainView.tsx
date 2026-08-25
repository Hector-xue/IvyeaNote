import { useEffect, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import {
  EditorView,
  keymap,
  highlightActiveLine,
  highlightActiveLineGutter,
  lineNumbers,
  drawSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, indentUnit } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import logoUrl from '../assets/logo.svg';
import type { VaultMeta } from '../lib/store';
import type { SyncReport } from '../lib/sync';

export interface FileNode {
  path: string;
  name: string;
  dir: string;
}

/** 把扁平路径列表按目录分组（侧栏渲染用） */
export function buildTree(paths: string[]): Map<string, FileNode[]> {
  const map = new Map<string, FileNode[]>();
  for (const p of paths) {
    const idx = p.lastIndexOf('/');
    const dir = idx > 0 ? p.slice(0, idx) : '';
    const name = idx > 0 ? p.slice(idx + 1) : p;
    if (!map.has(dir)) map.set(dir, []);
    map.get(dir)!.push({ path: p, name, dir });
  }
  return map;
}

interface Props {
  vault: VaultMeta;
  files: string[];
  currentPath: string | null;
  doc: string | null;
  syncing: boolean;
  lastReport: SyncReport | null;
  onSelect(path: string): void;
  onEdit(path: string, text: string): void;
  onCreateNote(): void;
  onNewFolderNote(folder: string): void;
  onDeleteFile(path: string): void;
  /** 只上传：本地 → 服务器 */
  onUpload(): void;
  /** 只拉取：服务器 → 本机 */
  onDownload(): void;
  onImportObsidian(): void;
  theme: 'light' | 'dark';
  onToggleTheme(): void;
  onBindFolder(): void;
  onUnbindFolder(): void;
  onLogout(): void;
  /** 是否已登录（未登录=本地模式，显示「登录同步」而非「退出登录」） */
  hasAccount: boolean;
  onOpenLogin(): void;
  /** 笔记库选择器（由外层注入，保持受控状态） */
  vaultSelector: React.ReactNode;
  onCreateVault(): void;
}

function cmExtensions(onEdit: (text: string) => void, dark: boolean) {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
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

export function MainView(props: Props) {
  const editorHost = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const tree = buildTree(props.files);

  // 创建 CodeMirror 实例（一次）
  useEffect(() => {
    const host = editorHost.current;
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

  // 切换文件或主题时重建编辑器状态
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

  return (
    <>
      <aside className="sidebar">
        <div className="side-head">
          <img src={logoUrl} alt="" className="brand-logo" />
          <span className="brand-name">Ivyea Note</span>
          <button
            className="icon-btn"
            title={props.theme === 'light' ? '切换深色' : '切换浅色'}
            onClick={props.onToggleTheme}
          >
            {props.theme === 'light' ? '🌙' : '☀️'}
          </button>
        </div>

        <div className="vault-row">
          {props.vaultSelector}
          <button className="icon-btn" title="新建笔记库" onClick={props.onCreateVault}>
            ＋
          </button>
        </div>

        <div className="sync-row">
          <button className="btn primary" onClick={props.onUpload} disabled={props.syncing}>
            ↑ 上传
          </button>
          <button className="btn" onClick={props.onDownload} disabled={props.syncing}>
            ↓ 拉取
          </button>
          {props.syncing && <span className="syncing-hint">同步中…</span>}
        </div>

        <div className="action-row">
          <button className="btn ghost" onClick={props.onImportObsidian}>
            导入 Obsidian
          </button>
        </div>

        {!props.vault.localPath ? (
          <button className="bind" onClick={props.onBindFolder}>
            绑定本地文件夹
          </button>
        ) : (
          <div className="bound-path" title={props.vault.localPath}>
            📁 {props.vault.localPath}
            <button onClick={props.onUnbindFolder}>解绑</button>
          </div>
        )}

        <div className="file-list">
          {[...tree.entries()].map(([dir, nodes]) => (
            <div key={dir || '/'} className="dir-group">
              {dir && (
                <div
                  className="dir-label"
                  onClick={() =>
                    setCollapsed((s) => {
                      const n = new Set(s);
                      if (n.has(dir)) n.delete(dir);
                      else n.add(dir);
                      return n;
                    })
                  }
                >
                  {collapsed.has(dir) ? '▸' : '▾'} {dir}
                </div>
              )}
              {!collapsed.has(dir) &&
                nodes.map((n) => (
                  <div
                    key={n.path}
                    className={`file ${props.currentPath === n.path ? 'active' : ''}`}
                    onClick={() => props.onSelect(n.path)}
                  >
                    <span className="file-name">{n.name}</span>
                    <span className="file-actions">
                      <button
                        title="在此文件夹新建笔记"
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onNewFolderNote(n.dir);
                        }}
                      >
                        ＋
                      </button>
                      <button
                        title="删除"
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onDeleteFile(n.path);
                        }}
                      >
                        ✕
                      </button>
                    </span>
                  </div>
                ))}
            </div>
          ))}
          {props.files.length === 0 && (
            <div className="empty">还没有笔记。可「新建笔记」或从 Obsidian 一键导入。</div>
          )}
        </div>

        <div className="sidebar-foot">
          <button onClick={props.onCreateNote}>＋ 新建笔记</button>
          {props.hasAccount ? (
            <button onClick={props.onLogout}>退出登录</button>
          ) : (
            <button onClick={props.onOpenLogin}>登录同步</button>
          )}
        </div>
      </aside>

      <main className="editor-pane">
        <div className="editor-head">
          <span className="crumb">{props.currentPath ?? '未选择笔记'}</span>
          {props.lastReport && (
            <span className={`report ${props.lastReport.errors.length > 0 ? 'has-error' : ''}`}>
              ↑{props.lastReport.pushed} ↓{props.lastReport.pulled}
              {props.lastReport.merged > 0 && ` · 合并${props.lastReport.merged}`}
              {props.lastReport.conflicts.length > 0 && ` · 冲突${props.lastReport.conflicts.length}`}
              {props.lastReport.errors.length > 0 && ` · ⚠ ${props.lastReport.errors[0]}`}
            </span>
          )}
        </div>
        <div className="editor-host" ref={editorHost} />
      </main>
    </>
  );
}

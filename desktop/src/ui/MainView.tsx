import { useMemo } from 'react';
import logoUrl from '../assets/logo.svg';
import { MarkdownEditor } from './MarkdownEditor';
import { FileTree, buildFileTree } from './FileTree';
import { TabsBar } from './TabsBar';
import { RibbonIcon } from './Icons';
import { countWords } from '../lib/wordCount';
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

export type SortMode = 'name' | 'mtime';

interface Props {
  vault: VaultMeta;
  files: string[];
  /** v0.3.4：PDF 文件列表 */
  pdfs: string[];
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
  /**
   * 云同步不可用（未登录）：上传/拉取按钮显式禁用并提示，
   * 替代旧的静默 no-op（v0.3.3：本地模式解门控）。
   */
  syncDisabled?: boolean;
  /** v0.3.4：排序 */
  sortMode: SortMode;
  onSortChange(m: SortMode): void;
  /** v0.3.4：打开 PDF */
  onOpenPdf(path: string): void;
  pdfView: string | null;
  onClosePdf(): void;
  /** v0.3.4：插图与图片解析（透传给编辑器） */
  onInsertImage?: () => Promise<string | null>;
  resolveImage?: (rel: string) => Promise<string | null>;
  /** v0.4.0 T4：Obsidian 导入进度（null=未在导入） */
  importProgress?: { done: number; total: number } | null;
  /** v0.4.0 T5：回收站 */
  trashCount?: number;
  onOpenTrash?(): void;
  /** v0.5.0 U3：文件树折叠与新建文件夹 */
  collapsedDirs: Set<string>;
  onToggleDir(dir: string): void;
  onCreateFolder(parent?: string): void;
  /** v0.5.0 U2：多标签页 */
  tabs?: string[];
  activeTab?: string | null;
  onSelectTab?(path: string): void;
  onCloseTab?(path: string): void;
  /** v0.5.0 U5：ribbon 动作（预留扩展；当前仅 files） */
  onRibbonAction?(action: 'files'): void;
}

export function MainView(props: Props) {
  /** v0.5.0 U3：递归树由扁平路径构建 */
  const fileTree = useMemo(() => buildFileTree(props.files), [props.files]);
  const pdfTree = buildTree(props.pdfs);
  /** v0.5.0 U4：字数统计 */
  const stats = useMemo(() => countWords(props.doc ?? ''), [props.doc]);

  return (
    <>
      {/* v0.5.0 U5：左侧 icon ribbon（对标 Obsidian 功能栏） */}
      <nav className="ribbon" aria-label="功能栏">
        <button
          className="ribbon-btn"
          title="文件"
          aria-label="文件"
          onClick={() => props.onRibbonAction?.('files')}
        >
          <RibbonIcon name="folder" />
        </button>
        {props.onOpenTrash && (
          <button className="ribbon-btn" title="回收站" aria-label="回收站" onClick={props.onOpenTrash}>
            <RibbonIcon name="trash" />
          </button>
        )}
        <span className="ribbon-spacer" />
        <button
          className="ribbon-btn"
          title={props.theme === 'light' ? '切换深色' : '切换浅色'}
          aria-label="切换主题"
          onClick={props.onToggleTheme}
        >
          <RibbonIcon name={props.theme === 'light' ? 'moon' : 'sun'} />
        </button>
      </nav>
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
          <button
            className="btn primary"
            onClick={props.onUpload}
            disabled={props.syncing || props.syncDisabled}
            title={props.syncDisabled ? '云同步需要登录后可用' : '把本地修改推到服务器'}
          >
            ↑ 上传
          </button>
          <button
            className="btn"
            onClick={props.onDownload}
            disabled={props.syncing || props.syncDisabled}
            title={props.syncDisabled ? '云同步需要登录后可用' : '把服务器上的变更拉到本机'}
          >
            ↓ 拉取
          </button>
          {props.syncing && <span className="syncing-hint">同步中…</span>}
        </div>
        {props.syncDisabled && (
          <div className="login-hint">
            本地模式：笔记只存在这台设备上。
            <button onClick={props.onOpenLogin}>登录同步</button>
            后可多端同步。
          </div>
        )}

        <div className="action-row">
          <button className="btn ghost" onClick={props.onImportObsidian}>
            导入 Obsidian
          </button>
          <select
            className="sort-select"
            value={props.sortMode}
            title="排序方式"
            onChange={(e) => props.onSortChange(e.target.value as SortMode)}
          >
            <option value="name">按名称</option>
            <option value="mtime">按修改时间</option>
          </select>
        </div>
        {props.importProgress && (
          <div className="import-progress" title="正在导入 Obsidian 笔记">
            <div className="ip-bar">
              <div
                className="ip-fill"
                style={{
                  width:
                    props.importProgress.total > 0
                      ? `${Math.round((props.importProgress.done / props.importProgress.total) * 100)}%`
                      : '10%',
                }}
              />
            </div>
            <span className="ip-text">
              导入中 {props.importProgress.done}/{props.importProgress.total || '…'}
            </span>
          </div>
        )}

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
          {/* v0.5.0 U3：递归文件树（隐藏后缀 / hover 操作 / 多层折叠） */}
          <FileTree
            nodes={fileTree}
            currentPath={props.currentPath}
            collapsed={props.collapsedDirs}
            onToggleDir={props.onToggleDir}
            onSelectFile={props.onSelect}
            onNewNoteIn={props.onNewFolderNote}
            onNewFolderIn={props.onCreateFolder}
            onDeleteFile={props.onDeleteFile}
          />
          {/* v0.3.4：PDF 列表 */}
          {props.pdfs.length > 0 && (
            <div className="dir-group">
              <div className="dir-label pdf-label">📄 PDF</div>
              {[...pdfTree.entries()].map(([, nodes]) =>
                nodes.map((n) => (
                  <div
                    key={n.path}
                    className={`file pdf-file ${props.pdfView === n.path ? 'active' : ''}`}
                    onClick={() => props.onOpenPdf(n.path)}
                  >
                    <span className="file-name">{n.name}</span>
                  </div>
                ))
              )}
            </div>
          )}
          {props.files.length === 0 && props.pdfs.length === 0 && (
            <div className="empty">还没有笔记。可「新建笔记」或从 Obsidian 一键导入。</div>
          )}
        </div>

        <div className="sidebar-foot">
          <button onClick={props.onCreateNote}>＋ 新建笔记</button>
          <button onClick={() => props.onCreateFolder('')} title="新建根文件夹">
            ⊞ 新建文件夹
          </button>
          {props.onOpenTrash && (
            <button onClick={props.onOpenTrash} title="回收站">
              🗑 回收站{props.trashCount ? `（${props.trashCount}）` : ''}
            </button>
          )}
          {props.hasAccount ? (
            <button onClick={props.onLogout}>退出登录</button>
          ) : (
            <button onClick={props.onOpenLogin}>登录同步</button>
          )}
        </div>
      </aside>

      <main className="editor-pane">
        {/* v0.5.0 U2：标签栏 */}
        {props.tabs && props.tabs.length > 0 && props.onSelectTab && props.onCloseTab && (
          <TabsBar
            tabs={props.tabs}
            active={props.activeTab ?? props.currentPath}
            onSelect={props.onSelectTab}
            onClose={props.onCloseTab}
          />
        )}
        <div className="editor-head">
          <span className="crumb">
            {props.pdfView ? `📄 ${props.pdfView}` : (props.currentPath ?? '未选择笔记')}
            {props.pdfView && (
              <button className="link close-pdf" onClick={props.onClosePdf}>
                关闭预览
              </button>
            )}
          </span>
          {props.lastReport && (
            <span className={`report ${props.lastReport.errors.length > 0 ? 'has-error' : ''}`}>
              ↑{props.lastReport.pushed} ↓{props.lastReport.pulled}
              {props.lastReport.merged > 0 && ` · 合并${props.lastReport.merged}`}
              {props.lastReport.conflicts.length > 0 && ` · 冲突${props.lastReport.conflicts.length}`}
              {props.lastReport.errors.length > 0 && ` · ⚠ ${props.lastReport.errors[0]}`}
            </span>
          )}
        </div>
        {props.pdfView ? (
          <iframe className="pdf-frame" title={props.pdfView} src={props.pdfView} />
        ) : (
          <MarkdownEditor
            doc={props.doc ?? ''}
            onEdit={props.onEdit}
            currentPath={props.currentPath}
            theme={props.theme}
            onInsertImage={props.onInsertImage}
            resolveImage={props.resolveImage}
          />
        )}
        {/* v0.5.0 U4：底部状态栏（字数统计，对标 Obsidian） */}
        <div className="status-bar">
          <span>{props.currentPath ?? '未选择笔记'}</span>
          <span className="st-right">
            {stats.words.toLocaleString()} 词 · {stats.characters.toLocaleString()} 字符
          </span>
        </div>
      </main>
    </>
  );
}

import { useMemo, useState } from 'react';
import logoUrl from '../assets/logo.svg';
import { MarkdownEditor } from './MarkdownEditor';
import { FileTree, buildFileTree } from './FileTree';
import { TabsBar } from './TabsBar';
import { RibbonIcon } from './Icons';
import { RightPanel, loadRightPanelCollapsed, saveRightPanelCollapsed } from './RightPanel';
import { usePanelWidth } from '../hooks/usePanelWidth';
import { ContextMenu, type MenuAnchor } from './ContextMenu';
import { SearchPanel } from './SearchPanel';
import type { TreeNode } from './FileTree';
import { countWords } from '../lib/wordCount';
import type { VaultMeta } from '../lib/store';
import type { SyncReport } from '../lib/sync';
import type { SearchDoc } from '../lib/searchIndex';

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

// 排序方式的**唯一定义**在数据层。UI 只转发类型，避免两处各写一份、日后漂移。
export type { SortMode } from '../hooks/useVaultFiles';
import type { SortMode } from '../hooks/useVaultFiles';

interface Props {
  vault: VaultMeta;
  files: string[];
  /** 库内的空文件夹（只有 .keep 占位），不显式传就不会出现在树里 */
  emptyDirs?: string[];
  /** v0.8.2 E9：右侧第二个窗格的路径（null = 没分栏） */
  splitPath?: string | null;
  splitDoc?: string | null;
  onOpenSplit?(path?: string): void;
  /** E3：「移动到…」——右键菜单本来就点名要它，此前只有拖拽一条路 */
  onRequestMove?(path: string, isDir: boolean): void;
  onCloseSplit?(): void;
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
  /** v0.7.5 E1：侧栏拖拽移动文件/文件夹到目标文件夹（destDir='' 为库根） */
  onMovePath?(src: string, destDir: string, isDir: boolean): void;
  /** v0.7.9 E3：右键菜单里的「重命名」——由 App 弹输入框后再执行 */
  onRequestRename?(path: string): void;
  /** v0.7.9 E3：右键菜单里的「复制路径」 */
  onCopyPath?(path: string): void;
  /** v0.6.1 H7a：立即同步一次（推+拉）；未传时退回 onUpload */
  onSyncNow?(): void;
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
  /** v0.6.1 H6: add-device pairing */
  onAddDevice?(): void;
  /** v0.7.0 F3: wiki links */
  onOpenWiki?(target: string): void;
  /** v0.7.1 F6: [[ completion candidates */
  wikiTitles?: { path: string; title: string }[];
  /** v0.7.1 F7: paste/drop image handler */
  onPasteImage?(file: File): Promise<string | null>;
  /** v0.7.1 F8: graph view */
  onOpenGraph?(): void;
  /** v0.7.0 F4: tags panel */
  onOpenTags?(): void;
  onOpenSettings?(): void;
  /** v0.7.11 E7：侧栏搜索用的全库正文（与命令面板同一份索引） */
  searchDocs?: SearchDoc[];
  wikiOut?: string[];
  wikiBack?: string[];
  onOpenWikiPath?(path: string): void;
  addDeviceBusy?: boolean;
  /** v0.6.1 H7c：同步冲突待处理 */
  conflictCount?: number;
  onOpenConflicts?(): void;
}

export function MainView(props: Props) {
  /** v0.5.0 U3：递归树由扁平路径构建 */
  const fileTree = useMemo(
    () => buildFileTree(props.files, props.emptyDirs ?? []),
    [props.files, props.emptyDirs]
  );
  const [rightCollapsed, setRightCollapsed] = useState(loadRightPanelCollapsed);
  /** 方案 §4.4：侧栏与右栏可拖拽调宽，宽度持久化 */
  const sideW = usePanelWidth({
    key: 'ivnote.sidebar.width',
    defaultWidth: 264,
    min: 200,
    max: 520,
    edge: 'right',
    label: '侧栏',
  });
  const rightW = usePanelWidth({
    key: 'ivnote.rightPanel.width',
    defaultWidth: 248,
    min: 200,
    max: 520,
    edge: 'left',
    label: '右栏',
  });
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  /** v0.7.11 E7：侧栏在「文件树」与「搜索」之间切换（对标 Obsidian 的左栏标签） */
  const [sidebarTab, setSidebarTab] = useState<'files' | 'search'>('files');

  /** 右键菜单条目：文件与文件夹给不同的动作集 */
  const openMenu = (node: TreeNode, x: number, y: number) => {
    const items =
      node.type === 'dir'
        ? [
            { id: 'new', label: '在此新建笔记', run: () => props.onNewFolderNote(node.path) },
            { id: 'newdir', label: '在此新建子文件夹', run: () => props.onCreateFolder?.(node.path) },
            ...(props.onRequestMove
              ? [{ id: 'movedir', label: '移动到…', run: () => props.onRequestMove?.(node.path, true) }]
              : []),
            { id: 'copy', label: '复制路径', run: () => props.onCopyPath?.(node.path) },
          ]
        : [
            { id: 'open', label: '打开', run: () => props.onSelect(node.path) },
            ...(props.onOpenSplit
              ? [{ id: 'split', label: '在右侧打开', run: () => props.onOpenSplit?.(node.path) }]
              : []),
            { id: 'rename', label: '重命名…', run: () => props.onRequestRename?.(node.path) },
            ...(props.onRequestMove
              ? [{ id: 'move', label: '移动到…', run: () => props.onRequestMove?.(node.path, false) }]
              : []),
            { id: 'copy', label: '复制路径', run: () => props.onCopyPath?.(node.path) },
            { id: 'del', label: '删除', danger: true, run: () => props.onDeleteFile(node.path) },
          ];
    setMenu({ x, y, items });
  };
  const pdfTree = buildTree(props.pdfs);
  /** 分栏里两边是同一篇：右栏走只读实时预览（见下） */
  const sameDoc = !!props.splitPath && props.splitPath === props.currentPath;
  /** v0.5.0 U4：字数统计 */
  const stats = useMemo(() => countWords(props.doc ?? ''), [props.doc]);

  return (
    <>
      {/* v0.5.0 U5：左侧 icon ribbon（对标 Obsidian 功能栏） */}
      <nav className="ribbon" aria-label="功能栏">
        <button
          className={`ribbon-btn ${sidebarTab === 'files' ? 'on' : ''}`}
          title="文件"
          aria-label="文件"
          onClick={() => {
            setSidebarTab('files');
            props.onRibbonAction?.('files');
          }}
        >
          <RibbonIcon name="folder" />
        </button>
        <button
          className={`ribbon-btn ${sidebarTab === 'search' ? 'on' : ''}`}
          title="搜索"
          aria-label="搜索"
          onClick={() => setSidebarTab('search')}
        >
          <RibbonIcon name="search" />
        </button>
        {props.onOpenTrash && (
          <button className="ribbon-btn" title="回收站" aria-label="回收站" onClick={props.onOpenTrash}>
            <RibbonIcon name="trash" />
          </button>
        )}
        {props.onOpenTags && (
          <button className="ribbon-btn" title="标签" aria-label="标签" onClick={props.onOpenTags}>
            <RibbonIcon name="tag" />
          </button>
        )}

        {props.onOpenGraph && (
          <button className="ribbon-btn" title="图谱" aria-label="图谱" onClick={props.onOpenGraph}>
            <RibbonIcon name="graph" />
          </button>
        )}
        <span className="ribbon-spacer" />
        {props.onOpenSettings && (
          <button
            className="ribbon-btn"
            title="设置（Ctrl+,）"
            aria-label="设置"
            onClick={props.onOpenSettings}
          >
            <RibbonIcon name="settings" />
          </button>
        )}
        <button
          className="ribbon-btn"
          title={props.theme === 'light' ? '切换深色' : '切换浅色'}
          aria-label="切换主题"
          onClick={props.onToggleTheme}
        >
          <RibbonIcon name={props.theme === 'light' ? 'moon' : 'sun'} />
        </button>
      </nav>
      <aside
        className="sidebar"
        style={{ width: sideW.width, minWidth: sideW.width, maxWidth: sideW.width }}
      >
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
          {/* v0.6.1 H7a：全自动同步——按钮收敛为一个（点一下=推+拉），平时自动触发 */}
          <button
            className={`btn primary ${props.syncing ? '' : 'auto-synced'}`}
            onClick={props.onSyncNow ?? props.onUpload}
            disabled={props.syncing || props.syncDisabled}
            title={
              props.syncDisabled
                ? '登录后自动多端同步'
                : props.syncing
                  ? '同步中…'
                  : '已自动同步；点击立即同步一次'
            }
          >
            {props.syncing ? '⟳ 同步中…' : '⟳ 同步'}
          </button>
          {props.lastReport && !props.syncing && (props.conflictCount ?? 0) > 0 && props.onOpenConflicts && (
            <button className="conflict-entry" onClick={props.onOpenConflicts} title="点击处理冲突">
              ⚠ {props.conflictCount} 个冲突待处理
            </button>
          )}
          {props.lastReport && !props.syncing && (props.conflictCount ?? 0) === 0 && (
            <span className="syncing-hint" title={`本次推送 ${props.lastReport.pushed} / 拉取 ${props.lastReport.pulled}`}>
              已同步 · 刚刚
            </span>
          )}
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
          {sidebarTab === 'search' ? (
            <SearchPanel
              docs={props.searchDocs ?? []}
              currentPath={props.currentPath}
              onOpen={props.onSelect}
            />
          ) : (
          <>
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
            onMovePath={props.onMovePath}
            onContextMenu={openMenu}
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
          </>
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
          {props.hasAccount && props.onAddDevice && (
            <button onClick={props.onAddDevice} disabled={props.addDeviceBusy} title="在新设备上免密码登录">
              📱 添加设备
            </button>
          )}
          {props.hasAccount ? (
            <button onClick={props.onLogout}>退出登录</button>
          ) : (
            <button onClick={props.onOpenLogin}>登录同步</button>
          )}
        </div>
      </aside>

      <div className={`panel-resizer ${sideW.dragging ? 'dragging' : ''}`} {...sideW.handleProps} />
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
          {props.onOpenSplit && !props.pdfView && props.currentPath && (
            <button
              className="icon-btn split-toggle"
              title={props.splitPath ? '关闭分栏' : '左右分栏（当前笔记的实时预览）'}
              aria-label="左右分栏"
              onClick={() => (props.splitPath ? props.onCloseSplit?.() : props.onOpenSplit?.())}
            >
              ⫿
            </button>
          )}
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
          <div className={`editor-split ${props.splitPath ? 'on' : ''}`}>
            <div className="editor-col">
              <MarkdownEditor
                doc={props.doc ?? ''}
                onEdit={props.onEdit}
                currentPath={props.currentPath}
                theme={props.theme}
                onInsertImage={props.onInsertImage}
                resolveImage={props.resolveImage}
                onOpenWiki={props.onOpenWiki}
                wikiTitles={props.wikiTitles}
                onPasteImage={props.onPasteImage}
              />
            </div>
            {props.splitPath && (
              <div className="editor-col split">
                <div className="split-head">
                  <span className="split-title" title={props.splitPath}>
                    {sameDoc ? '实时预览' : props.splitPath}
                  </span>
                  <button className="icon-btn" title="关闭右栏" onClick={props.onCloseSplit}>
                    ✕
                  </button>
                </div>
                <MarkdownEditor
                  /* 同一篇文章开两个可编辑视图会各写各的、互相覆盖，所以同文档时右栏只读 */
                  doc={(sameDoc ? props.doc : props.splitDoc) ?? ''}
                  onEdit={props.onEdit}
                  currentPath={props.splitPath}
                  theme={props.theme}
                  resolveImage={props.resolveImage}
                  onOpenWiki={props.onOpenWiki}
                  wikiTitles={props.wikiTitles}
                  readOnlyPreview={sameDoc}
                />
              </div>
            )}
          </div>
        )}
        {/* v0.5.0 U4：底部状态栏（字数统计，对标 Obsidian） */}
        <div className="status-bar">
          <span>{props.currentPath ?? '未选择笔记'}</span>
          <span className="st-right">
            {stats.words.toLocaleString()} 词 · {stats.characters.toLocaleString()} 字符
          </span>
        </div>
      </main>
      {/* v0.7.9 E8：右栏常驻大纲 + 双链。移动端早有，桌面此前缺席 */}
      {!rightCollapsed && (
        <div className={`panel-resizer ${rightW.dragging ? 'dragging' : ''}`} {...rightW.handleProps} />
      )}
      <RightPanel
        width={rightW.width}
        doc={props.doc}
        wikiOut={props.wikiOut}
        wikiBack={props.wikiBack}
        onOpenWiki={props.onOpenWiki}
        onOpenWikiPath={props.onOpenWikiPath}
        collapsed={rightCollapsed}
        onToggle={() => {
          const next = !rightCollapsed;
          setRightCollapsed(next);
          saveRightPanelCollapsed(next);
        }}
      />
      <ContextMenu anchor={menu} onClose={() => setMenu(null)} />
    </>
  );
}

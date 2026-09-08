import { useCallback, useMemo, useState } from 'react';
import logoUrl from '../assets/logo.png';
import { MarkdownEditor } from './MarkdownEditor';
import { FileTree, buildFileTree } from './FileTree';
import { RibbonIcon } from './Icons';
import { InlineTitle } from './InlineTitle';
import { RightPanel, loadRightPanelCollapsed, saveRightPanelCollapsed } from './RightPanel';
import { usePanelWidth } from '../hooks/usePanelWidth';
import { ContextMenu, type MenuAnchor } from './ContextMenu';
import { SearchPanel } from './SearchPanel';
import { PdfViewer } from './PdfViewer';
import { BaseView } from './BaseView';
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
  /** v0.8.4 E7：侧栏搜索点命中行 → 打开并跳到那一行 */
  onOpenAt?(path: string, line: number): void;
  /** P4.3：点同步报告 → 打开同步状态面板（报告只说上次干了什么，面板说现在还差什么） */
  onOpenSyncStatus?(): void;
  jumpTo?: { path: string; line: number; n: number } | null;
  /** v0.8.6 E10：编辑器行为偏好 */
  defaultView?: 'edit' | 'read';
  /** v0.11.4：阅读/编辑由 App 持有——顶栏那个开关和编辑器得是同一份状态 */
  viewMode?: 'edit' | 'read';
  onViewModeChange?(m: 'edit' | 'read'): void;
  livePreviewOn?: boolean;
  onCloseSplit?(): void;
  /** v0.3.4：PDF 文件列表 */
  pdfs: string[];
  /**
   * v0.11.1：库内**全部可见文件**。文件树改由它构建（此前只用 `.md`），
   * PDF / 图片 / 其它附件从此待在它们真正所在的文件夹里，而不是侧栏最底下
   * 一个脱离目录结构的扁平分组。不传就退回只显示笔记（移动端仍走 files）。
   */
  allFiles?: string[];
  /** v0.11.1：点开既不是笔记也不是 PDF 的文件（图片预览 / 交给系统应用） */
  onOpenAttachment?(path: string): void;
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
  /** v0.10.2：普通 Markdown 链接指向库内文件时打开它（路径已解析成库内相对路径） */
  onOpenPath?(relPath: string): void;
  /** v0.7.9 E3：右键菜单里的「重命名」——由 App 弹输入框后再执行 */
  onRequestRename?(path: string): void;
  /** 直接改名（内联标题用：拿到新名字就改，不弹框） */
  onRenameFile?(path: string, nextName: string): void;
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
  /** 登录态过期：refresh token 也被服务端拒了，只能重新登录 */
  sessionExpired?: boolean;
  /**
   * 侧边栏是否展开（Obsidian 的 Ctrl+\）。整块连同它右边那条拖宽手柄一起收掉——
   * 只把 `<aside>` 藏了、留着手柄，会出现"一条能拖的缝"这种鬼东西。
   */
  sidebarOpen?: boolean;
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
  /**
   * v0.11.10：正在看的 `.base` 表格。与编辑器、PDF 三选一。
   * 传进来的是内容本身而不是一个现成的 ReactNode——这个仓库栽过
   * 「属性声明了却一次都没渲染」的跟头（v0.11.9 的 vaultSelector）。
   */
  baseDoc?: { path: string; text: string } | null;
  /** 库里全部笔记（.base 求值要读 frontmatter / 标签 / 链接） */
  baseNotes?: { path: string; content: string }[];
  onCloseBase?(): void;
  onOpenBaseExternal?(path: string): void;
  pdfView: string | null;
  /** v0.11.0：正在预览的 PDF 的库内路径（pdfView 是 blob URL，说明不了是哪个文件） */
  pdfPath?: string | null;
  /** v0.11.0：交给系统 PDF 应用（绑了磁盘文件夹时才给） */
  onOpenPdfExternal?(path: string): void;
  onClosePdf(): void;
  /** v0.3.4：插图与图片解析（透传给编辑器） */
  onInsertImage?: (notePath: string | null) => Promise<string | null>;
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
  /** v0.5.0 U5：ribbon 动作（预留扩展；当前仅 files） */
  onRibbonAction?(action: 'files'): void;
  /** v0.6.1 H6: add-device pairing */
  onAddDevice?(): void;
  /** v0.7.0 F3: wiki links */
  onOpenWiki?(target: string): void;
  /** v0.7.1 F6: [[ completion candidates */
  wikiTitles?: { path: string; title: string }[];
  /** v0.7.1 F7: paste/drop image handler */
  onPasteImage?(file: File, notePath: string | null): Promise<string | null>;
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
    () => buildFileTree(props.allFiles ?? props.files, props.emptyDirs ?? []),
    [props.allFiles, props.files, props.emptyDirs]
  );

  /**
   * 点树里的一个文件该干什么，**只有这一处判定**。
   * 侧栏、右键菜单的「打开」都走它——两处各写一份就会长歪（这个仓库的老毛病）。
   */
  const openTreeFile = useCallback(
    (path: string) => {
      if (/\.(md|markdown)$/i.test(path)) props.onSelect(path);
      else if (/\.pdf$/i.test(path)) props.onOpenPdf(path);
      else props.onOpenAttachment?.(path);
    },
    // props 整体做依赖：这几个回调都来自 App，且 App 每次渲染都会给新引用
    [props]
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

  /**
   * v0.10.0：从侧栏清走的东西没有消失，只是换了落点——
   * 库切换/新建库/绑定文件夹进「库名」下拉，排序进图标条，同步进状态栏。
   * 侧栏从上到下只剩：库名、一行图标、文件树（Obsidian 就是这样）。
   */
  const openVaultMenu = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const items: MenuAnchor['items'] = [
      { id: 'new-vault', label: '新建笔记库…', icon: 'folder-plus', run: () => props.onCreateVault() },
      { id: 'import', label: '从 Obsidian 导入…', icon: 'move', run: () => props.onImportObsidian() },
      { type: 'sep', id: 's-vault' },
    ];
    if (props.vault.localPath && !props.vault.localPath.startsWith('opfs://')) {
      items.push({
        id: 'unbind',
        label: `解绑文件夹（${props.vault.localPath}）`,
        icon: 'folder',
        run: () => props.onUnbindFolder(),
      });
    } else {
      items.push({ id: 'bind', label: '绑定本地文件夹…', icon: 'folder', run: () => props.onBindFolder() });
    }
    setMenu({ x: r.left, y: r.bottom + 4, items });
  };

  const openSortMenu = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setMenu({
      x: r.left,
      y: r.bottom + 4,
      items: [
        // 打勾走 checked，不再往标签里塞一个 ✓——那样两种排序的文字长度都不一样
        { id: 'name', label: '按名称', checked: props.sortMode === 'name', run: () => props.onSortChange('name') },
        {
          id: 'mtime',
          label: '按修改时间',
          checked: props.sortMode === 'mtime',
          run: () => props.onSortChange('mtime'),
        },
      ],
    });
  };

  /** 全部折叠：把树里所有目录塞进折叠集合 */
  const collapseAll = () => {
    if (!props.onToggleDir) return;
    const dirs: string[] = [];
    const walk = (ns: TreeNode[]) => {
      for (const n of ns) {
        if (n.type === 'dir') {
          dirs.push(n.path);
          walk(n.children ?? []);
        }
      }
    };
    walk(fileTree);
    // 已折叠的跳过，否则会把它们又切回展开
    for (const d of dirs) if (!props.collapsedDirs?.has(d)) props.onToggleDir(d);
  };
  /** v0.7.11 E7：侧栏在「文件树」与「搜索」之间切换（对标 Obsidian 的左栏标签） */
  const [sidebarTab, setSidebarTab] = useState<'files' | 'search'>('files');
  const sideOpen = props.sidebarOpen ?? true;

  /** 右键菜单条目：文件与文件夹给不同的动作集 */
  const openMenu = (node: TreeNode, x: number, y: number) => {
    const items: MenuAnchor['items'] =
      node.type === 'dir'
        ? [
            { id: 'new', label: '在此新建笔记', icon: 'file-plus', run: () => props.onNewFolderNote(node.path) },
            {
              id: 'newdir',
              label: '在此新建子文件夹',
              icon: 'folder-plus',
              run: () => props.onCreateFolder?.(node.path),
            },
            { type: 'sep', id: 's-dir' },
            ...(props.onRequestMove
              ? ([{ id: 'movedir', label: '移动到…', icon: 'move', run: () => props.onRequestMove?.(node.path, true) }] as MenuAnchor['items'])
              : []),
            { id: 'copy', label: '复制路径', icon: 'copy', run: () => props.onCopyPath?.(node.path) },
          ]
        : [
            { id: 'open', label: '打开', icon: 'file', run: () => openTreeFile(node.path) },
            ...(props.onOpenSplit
              ? ([{ id: 'split', label: '在右侧打开', icon: 'sidebar', run: () => props.onOpenSplit?.(node.path) }] as MenuAnchor['items'])
              : []),
            { type: 'sep', id: 's-open' },
            { id: 'rename', label: '重命名…', icon: 'edit', run: () => props.onRequestRename?.(node.path) },
            ...(props.onRequestMove
              ? ([{ id: 'move', label: '移动到…', icon: 'move', run: () => props.onRequestMove?.(node.path, false) }] as MenuAnchor['items'])
              : []),
            { id: 'copy', label: '复制路径', icon: 'copy', run: () => props.onCopyPath?.(node.path) },
            { type: 'sep', id: 's-del' },
            { id: 'del', label: '删除', icon: 'trash', danger: true, run: () => props.onDeleteFile(node.path) },
          ];
    setMenu({ x, y, items });
  };
  /** 分栏里两边是同一篇：右栏走只读实时预览（见下） */
  const sameDoc = !!props.splitPath && props.splitPath === props.currentPath;
  /** v0.5.0 U4：字数统计 */
  const stats = useMemo(() => countWords(props.doc ?? ''), [props.doc]);
  /** 上一次同步报告里有错 = 现在的状态不是"已同步"。别再一律写「已同步」 */
  const syncFailed = !props.syncDisabled && (props.lastReport?.errors.length ?? 0) > 0;
  /**
   * 一份同步报告都还没有 = 这个会话里**一次都没同步成功过**，同样说不出「已同步」。
   *
   * 报告是 null 时 `syncFailed` 也是 false，于是这里照样写「已同步」——
   * 而"登录着、但同步引擎因为库没接上根本没跑完过"正好就是这种状态：
   * 状态栏一片祥和，另一台设备什么也收不到（2026-09-08 用户就是这么被误导的）。
   */
  const syncPending = !props.syncDisabled && !props.syncing && !props.lastReport;
  /** 过期比"失败"更明确：告诉用户要做什么，而不是让他对着一条红字猜 */
  const expired = !props.syncDisabled && !!props.sessionExpired;
  /** 编辑器交出来的「按 key 施加格式」入口。桌面只用它的 'image' 一路 */
  const [applyFormat, setApplyFormat] = useState<((key: string) => void) | null>(null);
  /*
   * **必须是稳定引用**。编辑器那个 exposeFormat 的 effect 依赖它，内联箭头
   * 每次渲染都是新函数 → effect 重跑 → setApplyFormat 换成新的回调 → 再渲染，
   * 永远停不下来（v0.10.7 桌面接这条线时当场撞上：整个测试进程挂死）。
   */
  const exposeFormat = useCallback((fn: ((key: string) => void) | null) => {
    setApplyFormat(() => fn);
  }, []);

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
      {/* 折叠靠宽度过渡，所以**不卸载**：卸载了就没有可过渡的东西（见 index.css） */}
      <aside
        className={`sidebar ${sideOpen ? '' : 'collapsed'}`}
        aria-hidden={!sideOpen}
        style={
          sideOpen
            ? { width: sideW.width, minWidth: sideW.width, maxWidth: sideW.width }
            : { width: 0, minWidth: 0, maxWidth: 0 }
        }
      >
        <div className="side-head">
          <img src={logoUrl} alt="" className="brand-logo" />
          <button
            className="vault-btn"
            title="切换笔记库 / 绑定文件夹"
            onClick={(e) => openVaultMenu(e.currentTarget)}
          >
            <span className="vault-name">{props.vault.name}</span>
            <RibbonIcon name="chevron-down" size={14} />
          </button>
        </div>

        {/*
          v0.10.2：删掉了这里的「文件 / 搜索」标签行。
          它和左边 ribbon 上那两个图标是**同一份状态、同一个动作**，两者相距不到
          一指宽——用户看到的就是"同一个功能有两个按钮"。ribbon 是 Obsidian 的
          面板切换器，留它一个就够，侧栏还能多出一行文件树的高度。
        */}
        {/* Obsidian 式图标操作条：新建笔记 / 新建文件夹 / 排序 / 全部折叠。
            此前这些是侧栏底部的 2×2 emoji 按钮格，和文件树离得最远、还最抢眼 */}
        {sidebarTab === 'files' && (
        <div className="side-actions">
          <button className="icon-btn" title="新建笔记" onClick={props.onCreateNote}>
            <RibbonIcon name="file-plus" size={17} />
          </button>
          <button className="icon-btn" title="新建文件夹" onClick={() => props.onCreateFolder('')}>
            <RibbonIcon name="folder-plus" size={17} />
          </button>
          <button
            className="icon-btn"
            title={props.sortMode === 'name' ? '排序：按名称' : '排序：按修改时间'}
            onClick={(e) => openSortMenu(e.currentTarget)}
          >
            <RibbonIcon name="sort" size={17} />
          </button>
          <button className="icon-btn" title="全部折叠" onClick={collapseAll}>
            <RibbonIcon name="collapse" size={17} />
          </button>
        </div>
        )}

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


        <div className="file-list">
          {sidebarTab === 'search' ? (
            <SearchPanel
              docs={props.searchDocs ?? []}
              currentPath={props.currentPath}
              onOpen={props.onSelect}
              onOpenAt={props.onOpenAt}
            />
          ) : (
          <>
          {/* v0.5.0 U3：递归文件树（隐藏后缀 / hover 操作 / 多层折叠） */}
          <FileTree
            nodes={fileTree}
            /* 打开的是 PDF 时，高亮的应该是那个 PDF 而不是上一篇笔记 */
            currentPath={props.pdfPath ?? props.currentPath}
            collapsed={props.collapsedDirs}
            onToggleDir={props.onToggleDir}
            onSelectFile={openTreeFile}
            onNewNoteIn={props.onNewFolderNote}
            onNewFolderIn={props.onCreateFolder}
            onDeleteFile={props.onDeleteFile}
            onMovePath={props.onMovePath}
            onContextMenu={openMenu}
          />
          {/*
            v0.11.1：**删掉侧栏底部那个扁平的「PDF」分组**。
            它从 v0.3.4 起就钉在整棵树下面，`obsidian/文章/x.pdf` 在那里只剩一个
            文件名、脱离所在目录，几十篇笔记的库里根本滚不到——用户的原话是
            「pdf 依旧识别不到」。现在 PDF 和其它附件都在树里它们自己的文件夹中。
          */}
          {(props.allFiles ?? props.files).length === 0 && (
            <div className="empty">还没有笔记。可「新建笔记」或从 Obsidian 一键导入。</div>
          )}
          </>
          )}
        </div>

      </aside>

      {sideOpen && (
        <div className={`panel-resizer ${sideW.dragging ? 'dragging' : ''}`} {...sideW.handleProps} />
      )}
      <main className="editor-pane">
        {/*
          v0.10.7：**顶部标签栏删掉了**（用户：「顶栏太丑了，删掉吧，把对应按钮
          放在下面那一行」）。编辑区上方从此一条横栏都没有，正文直接顶到窗口边。

          它原来担着两件事，都搬到底部状态栏那一行去了：
          - 「现在开着哪一篇」→ 状态栏左侧（那个位置本来就是空的，
            旧注释写着「文件名在标签栏已经有了」，现在标签栏没了，它就该回来）；
          - 右端那颗「分栏」按钮 → 状态栏右侧的动作区。
          切换笔记走侧栏文件树与 Ctrl+O 快速切换，和 Obsidian 关掉标签栏后一样。
        */}
        {/* v0.10.0：删掉了编辑区上方那行文件名——标签栏已经说明是哪一篇，
            再写一遍就是重复。PDF 预览时仍需要一行来放「关闭预览」。 */}
        {/* v0.11.0：PDF 自己带工具条（页码/缩放/关闭），不再需要上面那行面包屑——
            它原本打印的还是 `blob:tauri://…` 那一长串，而不是文件名 */}
        {props.baseDoc ? (
          <BaseView
            path={props.baseDoc.path}
            text={props.baseDoc.text}
            notes={props.baseNotes ?? []}
            onOpenNote={(p) => {
              props.onCloseBase?.();
              props.onSelect(p);
            }}
            onClose={() => props.onCloseBase?.()}
            onOpenExternal={
              props.onOpenBaseExternal
                ? () => props.onOpenBaseExternal?.(props.baseDoc!.path)
                : undefined
            }
          />
        ) : props.pdfView ? (
          <PdfViewer
            url={props.pdfView}
            path={props.pdfPath ?? ''}
            onClose={props.onClosePdf}
            onOpenExternal={
              props.onOpenPdfExternal && props.pdfPath
                ? () => props.onOpenPdfExternal?.(props.pdfPath!)
                : undefined
            }
          />
        ) : (
          <div className={`editor-split ${props.splitPath ? 'on' : ''}`}>
            <div className="editor-col">
              {/* 内联标题：文件名即标题，改它就是改文件名（Obsidian 同款） */}
              {props.onRenameFile && (
                <InlineTitle
                  path={props.currentPath}
                  onRename={(p, name) => props.onRenameFile?.(p, name)}
                />
              )}
              <MarkdownEditor
                doc={props.doc ?? ''}
                onEdit={props.onEdit}
                currentPath={props.currentPath}
                jumpTo={props.jumpTo}
                defaultView={props.defaultView}
                mode={props.viewMode}
                onModeChange={props.onViewModeChange}
                livePreviewOn={props.livePreviewOn}
                theme={props.theme}
                onInsertImage={props.onInsertImage}
                resolveImage={props.resolveImage}
                onOpenWiki={props.onOpenWiki}
                onOpenPath={props.onOpenPath}
                wikiTitles={props.wikiTitles}
                onPasteImage={props.onPasteImage}
                /* 桌面此前从不传 exposeFormat，于是编辑器里的 doInsertImage
                   是彻头彻尾的死代码。状态栏那颗「插入图片」就靠它 */
                exposeFormat={exposeFormat}
              />
            </div>
            {props.splitPath && (
              <div className="editor-col split">
                <div className="split-head">
                  <span className="split-title" title={props.splitPath}>
                    {sameDoc ? '实时预览' : props.splitPath}
                  </span>
                  <button className="icon-btn" title="关闭右栏" onClick={props.onCloseSplit}>
                    <RibbonIcon name="close" size={14} />
                  </button>
                </div>
                <MarkdownEditor
                  /* 同一篇文章开两个可编辑视图会各写各的、互相覆盖，所以同文档时右栏只读 */
                  doc={(sameDoc ? props.doc : props.splitDoc) ?? ''}
                  onEdit={props.onEdit}
                  currentPath={props.splitPath}
                  theme={props.theme}
                  livePreviewOn={props.livePreviewOn}
                  resolveImage={props.resolveImage}
                  onOpenWiki={props.onOpenWiki}
                  onOpenPath={props.onOpenPath}
                  wikiTitles={props.wikiTitles}
                  readOnlyPreview={sameDoc}
                />
              </div>
            )}
          </div>
        )}
        {/* v0.5.0 U4：底部状态栏（字数统计，对标 Obsidian） */}
        {/* v0.10.0：同步从侧栏那个大绿按钮降级到这里。Obsidian 的同步状态就待在
            右下角状态栏，安静、可点、不抢视线；侧栏留给文件树 */}
        <div className="status-bar">
          {/* v0.11.4：路径归顶栏的面包屑（Obsidian 的 view header 就在那儿）。
              两处都写就是这个仓库被骂过的「上下重复」。 */}
          <span className="st-right">
            {/*
              **插入图片**。这条能力从 v0.7.1 起就写好了（`useAttachments.insertImage`
              + 编辑器里的 `doInsertImage`），但桌面端**根本没有渲染过任何工具条**，
              `exposeFormat` 只有移动端会传——于是桌面上只能靠粘贴和拖入，
              用户的原话是「我的 ivyeanote 怎么无法插入图片啊，obsidian 就可以」。
              这是这个仓库第六次「能力写好了、入口没接」。
            */}
            {props.onInsertImage && props.currentPath && !props.pdfView && (
              <button
                className="st-item"
                title="插入图片（也可以直接粘贴或拖进来）"
                aria-label="插入图片"
                onClick={() => applyFormat?.('image')}
              >
                <RibbonIcon name="image" size={13} />
                插入图片
              </button>
            )}
            {props.onOpenSplit && !props.pdfView && props.currentPath && (
              <button
                className={`st-item ${props.splitPath ? 'on' : ''}`}
                title={props.splitPath ? '关闭分栏' : '左右分栏'}
                aria-label="左右分栏"
                onClick={() => (props.splitPath ? props.onCloseSplit?.() : props.onOpenSplit?.())}
              >
                <RibbonIcon name="sidebar" size={13} />
                {props.splitPath ? '关闭分栏' : '分栏'}
              </button>
            )}
            {(props.conflictCount ?? 0) > 0 && props.onOpenConflicts && (
              <button className="st-item st-conflict" onClick={props.onOpenConflicts}>
                {props.conflictCount} 个冲突待处理
              </button>
            )}
            {/*
              这里此前只要登录了就永远写「已同步」：服务器关着、上一次同步整个报错，
              状态栏照样一片祥和——而"电脑关了手机连不上"恰恰是本地服务器场景的
              日常。状态得说实话，失败要能点开看原因。
            */}
            <button
              className={`st-item ${props.syncing ? 'busy' : ''} ${syncFailed ? 'st-fail' : ''}`}
              onClick={
                props.syncDisabled || expired
                  ? props.onOpenLogin
                  : syncFailed && props.onOpenSyncStatus
                    ? props.onOpenSyncStatus
                    : (props.onSyncNow ?? props.onUpload)
              }
              title={
                props.syncDisabled
                  ? '本地模式：笔记只存在这台设备上，点此登录后多端同步'
                  : expired
                    ? '登录已过期（服务端不再认这台设备的令牌）；点此重新登录，笔记不会丢'
                    : props.syncing
                    ? '同步中…'
                    : syncFailed
                      ? `上次同步失败：${props.lastReport?.errors[0]}（点击查看还有什么没上去）`
                      : syncPending
                        ? '这台设备还没同步过；点击立即同步一次'
                        : '已自动同步；点击立即同步一次'
              }
            >
              <RibbonIcon
                name={props.syncDisabled ? 'file' : syncFailed || expired ? 'alert' : 'sync'}
                size={13}
              />
              {props.syncDisabled
                ? '本地模式'
                : expired
                  ? '登录已过期'
                  : props.syncing
                  ? '同步中'
                  : syncFailed
                    ? '同步失败'
                    : syncPending
                      ? '待同步'
                      : '已同步'}
            </button>
            {/*
              v0.11.2：**打开 PDF 时不再显示「0 词 · 0 字符」**——那是当前笔记的字数，
              而屏幕上摆着的是一份 PDF，写 0 只会让人以为出错了。
              另外补上反向链接数（Obsidian 状态栏就有这一项），点它展开右栏那个标签。
            */}
            {!props.pdfView && props.currentPath && (
              <>
                {props.onOpenWikiPath && (
                  <span className="st-item st-count" title="指向这篇笔记的链接数">
                    {(props.wikiBack ?? []).length} 条反向链接
                  </span>
                )}
                <span className="st-item st-count">
                  {stats.words.toLocaleString()} 词 · {stats.characters.toLocaleString()} 字符
                </span>
              </>
            )}
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

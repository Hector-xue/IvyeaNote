import { useCallback, useEffect, useMemo, useState } from 'react';
import logoUrl from '../assets/logo.png';
import { MarkdownEditor } from './MarkdownEditor';
import { FileTree, buildFileTree } from './FileTree';
import { RibbonIcon, type IconName } from './Icons';
import { InlineTitle } from './InlineTitle';
import { RightPanel, loadRightPanelCollapsed, saveRightPanelCollapsed } from './RightPanel';
import { usePanelWidth } from '../hooks/usePanelWidth';
import { ContextMenu, type MenuAnchor } from './ContextMenu';
import { aiSubmenu, type AiMenuAction } from '../lib/editorMenu';
import { SearchPanel } from './SearchPanel';
import { GraphView } from './GraphView';
import { TagPane, TrashPane } from './SidePanes';
import type { HistoryPaneProps } from './HistoryPane';
import type { RightTab } from './RightPanel';
import type { DeletedFile } from '../lib/api';
import { vaultDisplayName } from '../lib/vaultName';
import { PdfViewer } from './PdfViewer';
import { ImageViewer } from './ImageViewer';
import { BaseView } from './BaseView';
import { HtmlViewer } from './HtmlViewer';
import type { TreeNode } from './FileTree';
import { countWords } from '../lib/wordCount';
import type { VaultMeta } from '../lib/store';
import type { SyncReport } from '../lib/sync';
import type { SearchDoc } from '../lib/searchIndex';
import type { BaseNote } from '../lib/bases';

/** 左栏能显示的四种面板。ribbon 上那一排就是它们，一一对应 */
export type SidebarTab = 'files' | 'search' | 'tags' | 'trash';

/** ribbon 上的面板按钮。写成表是为了"按钮"和"面板"永远同源，加一个不会漏另一处 */
const PANES: { id: SidebarTab; icon: IconName; title: string }[] = [
  { id: 'files', icon: 'folder', title: '文件' },
  { id: 'search', icon: 'search', title: '搜索' },
  { id: 'tags', icon: 'tag', title: '标签' },
  { id: 'trash', icon: 'trash', title: '回收站' },
];

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
  /** 打开一篇笔记。newTab=true 表示另起一个标签（Ctrl/中键点侧栏、右键"在新标签打开"） */
  onSelect(path: string, newTab?: boolean): void;
  onEdit(path: string, text: string): void;
  onCreateNote(): void;
  onNewFolderNote(folder: string): void;
  onDeleteFile(path: string): void;
  /** v0.11.15：删除整个文件夹（里面的文件进回收站）。不传就不显示这个菜单项 */
  onDeleteFolder?(dir: string): void;
  /** v0.11.22：重命名文件夹——由 App 弹输入框后整棵子树换前缀 */
  onRenameFolder?(dir: string): void;
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
  onCreateVault(): void;
  /**
   * v0.11.25：库切换 / 删除。手机端早有切换（库名旁的 ∨），桌面一直没有——
   * 新建一个库之后旧库就再也回不去（用户原话）。
   */
  vaults?: { id: number; name: string; location: string }[];
  activeVaultId?: number | null;
  onSwitchVault?(id: number): void;
  onDeleteVault?(id: number): void;
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
  /** v0.11.18：正在看的 `.html`（主区渲染，沙箱 iframe 不跑脚本） */
  htmlDoc?: { path: string; html: string } | null;
  onCloseHtml?(): void;
  onOpenHtmlExternal?(path: string): void;
  resolveAsset?(rel: string): Promise<string | null>;
  readVaultText?(rel: string): Promise<string>;
  /** v0.11.24：HTML 脚本模式——工具的数据落到 `<path>.data.json` */
  writeVaultText?(rel: string, text: string): Promise<void>;
  htmlScriptsAllowed?: boolean;
  onHtmlScriptsToggle?(allow: boolean): void;
  /** 库里全部笔记（.base 求值要读 frontmatter / 标签 / 链接） */
  /**
   * v0.11.15：喂给 `.base` 的是**库里的全部文件**（含图片 / PDF / 别的 .base），
   * 不再只是笔记——非笔记的 content 是空串，靠 file.* 那组属性参与筛选。
   */
  baseNotes?: BaseNote[];
  onCloseBase?(): void;
  onOpenBaseExternal?(path: string): void;
  /**
   * v0.11.22：正在看的图片（主区里看，不再是盖住全屏的蒙层）。
   * `url` 是 blob URL，说明不了是哪个文件，所以路径要单独给。
   */
  imageView?: { path: string; url: string } | null;
  onCloseImage?(): void;
  onOpenImageExternal?(path: string): void;
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
  /** v0.11.16：左栏当前面板 + 切换回调（状态在 App） */
  sidebarTab?: SidebarTab;
  onSidebarTab?(tab: SidebarTab): void;
  /** v0.11.24：右栏「历史」标签的数据与动作（hooks/useFileHistory） */
  historyProps?: Omit<HistoryPaneProps, 'onClose'>;
  /** v0.11.24：外面（命令面板）要右栏切到某个标签；收起着就先展开 */
  wantRightTab?: RightTab | null;
  onWantRightTabConsumed?(): void;
  /** v0.11.16：回收站现在是左栏的一个面板，数据与动作由 App 给 */
  trashList?: readonly string[];
  onTrashRestore?(path: string): void;
  onTrashPurge?(path: string): void;
  onTrashPurgeAll?(): void;
  /** v0.11.24：云端已删除、本地没有的文件（回收站面板第二段） */
  cloudDeleted?: readonly DeletedFile[];
  onCloudRestore?(f: DeletedFile): void;
  /** v0.11.16：点标签 → 切到搜索面板并把 `#标签` 灌进搜索框 */
  onPickTag?(tag: string): void;
  /** v0.11.16：外部灌一个搜索词进侧栏搜索框（点标签用）。n 用来区分"又点了一次" */
  searchSeed?: { text: string; n: number } | null;
  /** v0.11.16：图谱现在在右栏；ribbon 那颗按钮只负责把它叫出来 */
  graphOpen?: boolean;
  /** 关掉图谱，回到刚才那篇笔记 */
  onCloseGraph?(): void;
  /** v0.11.16：今日日记。能力早就有（lib/daily + useTemplates），此前只有命令面板能到 */
  onOpenDaily?(): void;
  /** v0.11.18：选区读写桥（AI 动作要"只处理选中的那段"并能替换回去） */
  exposeSelection?(api: import('./MarkdownEditor').SelectionApi | null): void;
  /** v0.11.18：AI 结果面板（贴在编辑区下方；null = 不显示） */
  aiPanel?: React.ReactNode;
  /** v0.11.19：AI 动作进编辑器右键菜单与状态栏——只放在「⋯」里太深，用户根本没找到 */
  aiActions?: AiMenuAction[];
  onAi?(id: string): void;
  onTidy?(): void;
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
    (path: string, newTab?: boolean) => {
      if (/\.(md|markdown)$/i.test(path)) props.onSelect(path, newTab);
      else if (/\.pdf$/i.test(path)) props.onOpenPdf(path);
      else props.onOpenAttachment?.(path);
    },
    // props 整体做依赖：这几个回调都来自 App，且 App 每次渲染都会给新引用
    [props]
  );
  const [rightCollapsed, setRightCollapsed] = useState(loadRightPanelCollapsed);
  /** 主区现在放的是不是笔记编辑器（状态栏的形状和内容都按这个分） */
  const viewingNote = !props.pdfView && !props.htmlDoc && !props.baseDoc && !props.imageView && !props.graphOpen;
  // 命令面板「查看文件历史」：右栏收着的话先展开，不然点了什么都看不见
  useEffect(() => {
    if (props.wantRightTab && rightCollapsed) {
      setRightCollapsed(false);
      saveRightPanelCollapsed(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.wantRightTab]);
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
    const items: MenuAnchor['items'] = [];
    // 库列表排最上面：这张菜单是从库名旁边那个 ∨ 点开的，来这儿多半是为了换库
    for (const v of props.vaults ?? []) {
      items.push({
        id: `vault-${v.id}`,
        label: v.name,
        hint: v.location,
        icon: v.id === props.activeVaultId ? 'check' : 'folder',
        run: () => {
          if (v.id !== props.activeVaultId) props.onSwitchVault?.(v.id);
        },
      });
    }
    if ((props.vaults?.length ?? 0) > 0) items.push({ type: 'sep', id: 's-list' });
    items.push(
      { id: 'new-vault', label: '新建笔记库（选择文件夹）…', icon: 'folder-plus', run: () => props.onCreateVault() },
      { id: 'import', label: '从 Obsidian 导入…', icon: 'move', run: () => props.onImportObsidian() },
      { type: 'sep', id: 's-vault' }
    );
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
    if (props.onDeleteVault) {
      items.push({ type: 'sep', id: 's-del' });
      items.push({
        id: 'delete-vault',
        label: '删除这个笔记库…',
        hint: '文件夹里的文件不会被删',
        icon: 'trash',
        run: () => props.onDeleteVault?.(props.vault.id),
      });
    }
    setMenu({ x: r.left, y: r.bottom + 4, items });
  };

  /*
   * v0.11.14：`openSortMenu` / `collapseAll` 跟着那行按钮一起搬到 App 了
   * （顶栏左格要用它们，而顶栏由 App 渲染）。留在这儿会是两份实现。
   */
  /*
   * v0.11.16：左栏显示哪个面板**由 App 持有**。
   * 命令面板里的「标签」「回收站」也要能切过来，而那两条命令在 App 那边；
   * 状态留在这里就会出现"命令面板点了没反应"。
   */
  const sidebarTab: SidebarTab = props.sidebarTab ?? 'files';
  const sideOpen = props.sidebarOpen ?? true;

  /*
   * v0.11.14：把侧栏当前宽度写到根元素上。
   *
   * 顶栏（由 App 渲染，不在这棵子树里）要照着它决定左格有多宽——标签必须从
   * 内容区的左边界起画，当前标签才会落在它那一页的正上方。宽度归 usePanelWidth
   * 持有、还能拖，除了一个 CSS 变量没有别的办法把它交出去。
   * 收起时写 0：那一格连同里面的按钮一起消失，正是用户要的"一起收起来"。
   */
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.style.setProperty('--side-w', `${sideOpen ? sideW.width : 0}px`);
    return () => {
      root.style.removeProperty('--side-w');
    };
  }, [sideOpen, sideW.width]);

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
            /*
             * v0.11.22：**文件夹也要能改名**（用户点名）。此前只有文件那一支有
             * 「重命名…」，文件夹想换个名字只能新建一个再把东西一件件拖过去。
             */
            ...(props.onRenameFolder
              ? ([
                  {
                    id: 'renamedir',
                    label: '重命名…',
                    icon: 'edit',
                    run: () => props.onRenameFolder?.(node.path),
                  },
                ] as MenuAnchor['items'])
              : []),
            ...(props.onRequestMove
              ? ([{ id: 'movedir', label: '移动到…', icon: 'move', run: () => props.onRequestMove?.(node.path, true) }] as MenuAnchor['items'])
              : []),
            { id: 'copy', label: '复制路径', icon: 'copy', run: () => props.onCopyPath?.(node.path) },
            /*
             * v0.11.15：**文件夹也要能删**（用户：「文件夹右键点击没有删除选项」）。
             * 此前只有文件那一支有删除，文件夹在界面上根本没有任何删除入口——
             * 只能一篇篇删完，还剩个空壳。
             */
            ...(props.onDeleteFolder
              ? ([
                  { type: 'sep', id: 's-deldir' },
                  {
                    id: 'deldir',
                    label: '删除文件夹',
                    icon: 'trash',
                    danger: true,
                    run: () => props.onDeleteFolder?.(node.path),
                  },
                ] as MenuAnchor['items'])
              : []),
          ]
        : [
            { id: 'open', label: '打开', icon: 'file', run: () => openTreeFile(node.path) },
            { id: 'open-tab', label: '在新标签打开', icon: 'plus', run: () => openTreeFile(node.path, true) },
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
  /*
   * v0.11.14：**离线是一种状态，不是一次失败。**
   * 自动同步撞上"连不上服务器"时引擎会把错误吞掉、只留 offline 标记
   * （见 hooks/useSyncEngine 的 quiet）——状态栏照说实话，但用的是"离线"这个词：
   * 它准确、不吓人，而且明确指向"等网络回来"，而不是"你得去查服务端"。
   */
  const offline = !props.syncDisabled && !syncFailed && !!props.lastReport?.offline;
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
      {/*
        左侧 ribbon（v0.11.16 重做）。
        **这一排按钮现在只做一件事：切换左栏显示什么。**
        此前「文件 / 搜索」切面板，而「标签 / 回收站 / 图谱」点了盖一张对话框上来——
        同一排图标、两种行为，用户的原话是「很乱，视觉上体验很差」。
        现在标签和回收站都是左栏的面板，图谱去了右栏（它需要和正文并排看），
        日记是一个动作（今天那篇不存在就建、存在就打开），单独放在下面一组。
      */}
      <nav className="ribbon" aria-label="功能栏">
        {PANES.map((p) => (
          <button
            key={p.id}
            className={`ribbon-btn ${sidebarTab === p.id ? 'on' : ''}`}
            title={p.title}
            aria-label={p.title}
            aria-pressed={sidebarTab === p.id}
            onClick={() => {
              props.onSidebarTab?.(p.id);
              if (p.id === 'files') props.onRibbonAction?.('files');
            }}
          >
            <RibbonIcon name={p.icon} />
          </button>
        ))}
        {props.onOpenGraph && (
          <button
            className={`ribbon-btn ${props.graphOpen ? 'on' : ''}`}
            title="图谱（在右栏打开）"
            aria-label="图谱"
            aria-pressed={!!props.graphOpen}
            onClick={props.onOpenGraph}
          >
            <RibbonIcon name="graph" />
          </button>
        )}
        {props.onOpenDaily && (
          <button
            className="ribbon-btn"
            title="今日日记（没有就新建）"
            aria-label="今日日记"
            onClick={props.onOpenDaily}
          >
            <RibbonIcon name="calendar" />
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
            <span className="vault-name">{vaultDisplayName(props.vault)}</span>
            <RibbonIcon name="chevron-down" size={14} />
          </button>
        </div>

        {/*
          v0.10.2：删掉了这里的「文件 / 搜索」标签行。
          它和左边 ribbon 上那两个图标是**同一份状态、同一个动作**，两者相距不到
          一指宽——用户看到的就是"同一个功能有两个按钮"。ribbon 是 Obsidian 的
          面板切换器，留它一个就够，侧栏还能多出一行文件树的高度。
        */}
        {/*
          v0.11.14：这行「新建笔记 / 新建文件夹 / 排序 / 全部折叠」**搬到顶栏
          侧栏正上方那一格**去了（见 ui/TopBar 的 quick）。原因是标签页要和它
          底下那一页对齐，而侧栏上方那块地方装不下标签——用它装这四颗常用按钮，
          侧栏一收，这一格连按钮一起收掉。搬走而不是复制：同一个功能出现两次，
          正是这个仓库被点过名的毛病。
        */}

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
              seed={props.searchSeed ?? null}
            />
          ) : sidebarTab === 'tags' ? (
            <TagPane docs={props.searchDocs ?? []} onPick={(t) => props.onPickTag?.(t)} />
          ) : sidebarTab === 'trash' ? (
            <TrashPane
              list={props.trashList ?? []}
              onRestore={(p) => props.onTrashRestore?.(p)}
              onPurge={(p) => props.onTrashPurge?.(p)}
              onPurgeAll={props.onTrashPurgeAll}
              cloud={props.cloudDeleted}
              onCloudRestore={props.onCloudRestore}
            />
          ) : (
          <>
          {/* v0.5.0 U3：递归文件树（隐藏后缀 / hover 操作 / 多层折叠） */}
          <FileTree
            nodes={fileTree}
            /* 打开的是 PDF 时，高亮的应该是那个 PDF 而不是上一篇笔记 */
            currentPath={props.pdfPath ?? props.imageView?.path ?? props.currentPath}
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
        {/*
          v0.11.16：**图谱开在主区**，和 PDF / `.base` 一样占据编辑区那块。
          上一版把它放进了最右边那条大纲栏——用户纠正：「我说的图谱放在右侧窗口
          不是最右侧大纲这啊，是侧边栏的右侧，也就是中间空白的这里」。
          主区本来就是"当前在看什么"的位置，图谱是其中一种。
        */}
        {/*
          v0.11.22：**编辑区这一层单独包起来（`.editor-stage`）**。
          状态栏是浮层（`position:absolute; bottom:0`），此前它相对整个
          `.editor-pane` 定位——AI 面板一开，那条浮着的状态栏就正好压在面板的
          底栏上，「应用」按钮只露出半截（用户：「右下角有个按钮被盖住了」）。
          现在状态栏钉在这一层里，AI 面板排在这一层**外面**：浮层只会浮在正文上，
          永远盖不住下面那块面板。
        */}
        {/*
          v0.11.24：主区放的不是笔记（HTML / PDF / 图片 / 表格 / 图谱）时，
          状态栏改成**贴底的一条**而不是浮层：iframe 里的页面没法像正文那样给自己
          留 40vh 底部空白，浮层一定压住它最后一行（用户截图：「下面一行字又被挡住了」）。
          同时那几样只对笔记有意义的项（插入图片 / AI / 分栏 / 反链 / 字数）不再显示——
          此前 HTML 开着时 currentPath 还是上一篇笔记，状态栏照旧摆着"3,786 词"。
        */}
        <div className={`editor-stage ${viewingNote ? '' : 'stage-frame'}`}>
          {props.graphOpen ? (
            <GraphView
              docs={props.searchDocs ?? []}
              currentPath={props.currentPath}
              onOpenNote={(p) => props.onSelect(p)}
              onClose={() => props.onCloseGraph?.()}
            />
          ) : props.htmlDoc && props.resolveAsset && props.readVaultText ? (
            <HtmlViewer
              path={props.htmlDoc.path}
              html={props.htmlDoc.html}
              resolveAsset={props.resolveAsset}
              readText={props.readVaultText}
              writeText={props.writeVaultText}
              scriptsAllowed={props.htmlScriptsAllowed}
              onScriptsToggle={props.onHtmlScriptsToggle}
              onClose={() => props.onCloseHtml?.()}
              onOpenExternal={
                props.onOpenHtmlExternal ? () => props.onOpenHtmlExternal?.(props.htmlDoc!.path) : undefined
              }
            />
          ) : props.baseDoc ? (
            <BaseView
              path={props.baseDoc.path}
              text={props.baseDoc.text}
              notes={props.baseNotes ?? []}
              /*
               * 表里现在有图片和 PDF：一律走 onSelect 会拿文本通道去读一张 PNG，
               * 直接抛错。按类型分流，和文件树点开它们时走的是同一条路。
               */
              onOpenNote={(p) => {
                props.onCloseBase?.();
                if (/\.md$/i.test(p)) props.onSelect(p);
                else if (/\.pdf$/i.test(p)) props.onOpenPdf(p);
                else props.onOpenAttachment?.(p);
              }}
              onClose={() => props.onCloseBase?.()}
              onOpenExternal={
                props.onOpenBaseExternal
                  ? () => props.onOpenBaseExternal?.(props.baseDoc!.path)
                  : undefined
              }
            />
          ) : props.imageView ? (
            /*
             * 图片和 PDF 是同一件事的两种格式：都在主区看、都能缩放、都能交给
             * 系统应用。它们在这条链上挨着，将来加别的只读视图也照这个位置摆。
             */
            <ImageViewer
              url={props.imageView.url}
              path={props.imageView.path}
              onClose={() => props.onCloseImage?.()}
              onOpenExternal={
                props.onOpenImageExternal
                  ? () => props.onOpenImageExternal?.(props.imageView!.path)
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
                    doc={props.doc}
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
                  exposeSelection={props.exposeSelection}
                  aiActions={props.aiActions}
                  onAi={props.onAi}
                  onTidy={props.onTidy}
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
              {props.onInsertImage && props.currentPath && viewingNote && (
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
              {/*
                **AI**。v0.11.18 做完能力之后，入口只有顶栏「⋯」的二级菜单和命令面板，
                用户装完的第一句话是「为什么我没有看到任何 AI 按钮呢？只有在设置里面有」。
                这是这个仓库第七次「能力写好了、入口没接」——所以这一版给了两个明面上的
                入口：编辑区右键（选中文字后手就在那儿）和这颗状态栏按钮。
              */}
              {props.aiActions && props.aiActions.length > 0 && props.currentPath && viewingNote && (
                <button
                  className="st-item"
                  title="AI：校对、润色、精简、写摘要…（替换类动作要先选中一段文字）"
                  aria-label="AI"
                  onClick={(e) => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    /*
                     * 分段与右键菜单同一套（见 lib/editorMenu 的 aiSubmenu）：
                     * 会改正文的 / 只多给一段的 / 什么都不写的。这里不置灰——
                     * 状态栏这颗按钮离编辑区远，选区常常已经没了，点了会说清原因。
                     */
                    const items: MenuAnchor['items'] = aiSubmenu(props.aiActions!, true, (id) => props.onAi?.(id));
                    if (props.onTidy) {
                      items.push({ type: 'sep', id: 's-ai2' });
                      items.push({
                        id: 'tidy',
                        label: '整理排版',
                        hint: '本地规则，不联网',
                        icon: 'text-format',
                        run: () => props.onTidy?.(),
                      });
                    }
                    // 菜单开在按钮上方（状态栏在屏幕最底下，往下必然放不下）
                    const bar = (e.currentTarget as HTMLElement).closest('.status-bar')?.getBoundingClientRect();
                    setMenu({ x: r.left, y: r.bottom + 4, flipY: (bar?.top ?? r.top) - 4, items });
                  }}
                >
                  <RibbonIcon name="sparkle" size={13} />
                  AI
                </button>
              )}
              {props.onOpenSplit && viewingNote && props.currentPath && (
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
              {/*
                v0.11.25 删除熔断：本地一下少了一大批，引擎没推删除。这条必须比"已同步"
                更显眼——2026-09-11 就是在一片"已同步"的祥和里把整个库删掉的。
              */}
              {props.lastReport?.massDelete && props.onOpenSyncStatus && (
                <button
                  className="st-item st-guard"
                  onClick={props.onOpenSyncStatus}
                  title="本地少了一批已知文件，删除没有推送；点开看清单并决定怎么办"
                >
                  <RibbonIcon name="alert" size={13} />
                  本地少了 {props.lastReport.massDelete.missing} 篇，已暂停删除
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
                        : offline
                          ? '连不上服务器；网络恢复后会自动同步，点击立即重试'
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
                      : offline
                        ? '离线'
                        : syncPending
                          ? '待同步'
                          : '已同步'}
              </button>
              {/*
                v0.11.2：**打开 PDF 时不再显示「0 词 · 0 字符」**——那是当前笔记的字数，
                而屏幕上摆着的是一份 PDF，写 0 只会让人以为出错了。
                另外补上反向链接数（Obsidian 状态栏就有这一项），点它展开右栏那个标签。
              */}
              {viewingNote && props.currentPath && (
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
        </div>
        {props.aiPanel}
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
        historyProps={props.historyProps}
        wantTab={props.wantRightTab}
        onWantTabConsumed={props.onWantRightTabConsumed}
      />
      <ContextMenu anchor={menu} onClose={() => setMenu(null)} />
    </>
  );
}

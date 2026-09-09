/**
 * 移动端视图（v0.7.3 大改）：触屏优先的单栏布局，对标原生笔记 App 手感。
 * - 顶栏：抽屉开关 + 笔记名 + 同步；大标题行
 * - 抽屉：折叠树 + 长按操作菜单（删除/重命名）+ 搜索 + 排序
 * - 手势：主区右滑呼出抽屉；Android 返回键逐级回退（气泡→大纲→图片→抽屉→无）
 * - 主区：CodeMirror 编辑器 + 选区气泡工具栏 + 大纲浮层 + 图片全屏预览 + 反链区块
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import logoUrl from '../assets/logo.png';
import type { SearchDoc } from '../lib/searchIndex';
import type { BaseNote } from '../lib/bases';
import { RibbonIcon } from './Icons';
import { MarkdownEditor } from './MarkdownEditor';
import { PdfViewer } from './PdfViewer';
import { BaseView } from './BaseView';
import { InlineTitle } from './InlineTitle';
import { TopBar } from './mobile/TopBar';
import { BottomBar, type FormatAction } from './mobile/BottomBar';
import { Drawer } from './mobile/Drawer';
import { Sheet, type SheetItem } from './mobile/Sheet';
import { extractHeadings } from '../lib/headings';
import type { VaultMeta } from '../lib/store';
import type { SyncReport } from '../lib/sync';
import type { SortMode } from './MainView';

interface Props {
  /** v0.7.4：移动端更新检查入口 */
  onCheckUpdate?: () => void;
  vault: VaultMeta;
  files: string[];
  pdfs: string[];
  currentPath: string | null;
  doc: string | null;
  syncing: boolean;
  lastReport: SyncReport | null;
  /**
   * 全部笔记库 + 当前选中 + 切换回调。
   *
   * 这里原来是 `vaultSelector: React.ReactNode`——**声明了、从来没渲染过**。
   * 于是手机端根本没有切换笔记库的入口：库名旁边那个 ∨ 点开只有「新建笔记库」和
   * 「标签」。用户反馈「桌面端绑定的文件夹始终无法同步到手机」，真因就是这个：
   * 电脑推的是 A 库，手机停在 B 库，而手机换不过去。
   */
  vaults: { id: number; name: string }[];
  activeVaultId: number | null;
  onSwitchVault(id: number): void;
  onSelect(path: string): void;
  onEdit(path: string, text: string): void;
  onCreateNote(): void;
  /**
   * v0.8.3：移动端此前**没有任何新建文件夹的入口**——底部栏和长按菜单都没有，
   * 于是「移动到…」在手机上永远只有库根一个目标。正是方案 1.4 要杜绝的
   * 「移动端功能是空的」。
   */
  onCreateFolder?(parent?: string): void;
  onDeleteFile(path: string): void;
  /** v0.7.3 P1：重命名 */
  onRenameFile(path: string, newName: string): void;
  /** v0.7.3 P5：当前笔记的反向链接（App 层基于 searchDocs 计算） */
  backlinks?: string[];
  /** 空文件夹（只有 .keep）——搜索时不显示，避免结果里混进空目录 */
  emptyDirs?: string[];
  /**
   * v0.8.3：全库正文（与桌面命令面板 / 侧栏搜索同一份倒排索引）。
   * 移动端此前只按文件名 `includes` 过滤——记不住标题就找不着，等于没有搜索。
   */
  searchDocs?: SearchDoc[];
  /** v0.8.3：标签面板（桌面 ribbon 早就有，手机上一直没入口） */
  onOpenTags?(): void;
  /**
   * v0.8.3：从外部灌一个搜索词进抽屉（点标签用）。
   * 带序号是因为「连点同一个标签两次」也该重新搜——只看字符串会被 React 判定没变。
   */
  searchSeed?: { text: string; n: number } | null;
  /**
   * v0.8.3：长按操作单里的「移动到…」。
   * 方案 §4.6 写的是长按拖拽——小屏上拖到目标文件夹本身就难（目标一行高、还要
   * 同时滚列表），先给稳的选择器，移动端此前压根没有任何移动手段。
   */
  onRequestMove?(path: string, isDir: boolean): void;
  onSync(): void;
  /** v0.10.6：同步状态面板。桌面走命令面板，手机上此前完全没有入口 */
  onOpenSyncStatus?(): void;
  /** 待处理的同步冲突数。手机上此前既看不见也处理不了 */
  conflictCount?: number;
  onOpenConflicts?(): void;
  onCreateVault(): void;
  /** v0.10.2：打开设置面板（存储位置、外观、同步都在里面）。手机上此前没有任何入口 */
  onOpenSettings?(): void;
  /** v0.10.2：普通 Markdown 链接指向库内文件时打开它（路径已解析成库内相对路径） */
  onOpenPath?(relPath: string): void;
  onToggleTheme(): void;
  theme: 'light' | 'dark';
  onLogout(): void;
  hasAccount: boolean;
  onOpenLogin(): void;
  /** 登录态过期：refresh token 也被服务端拒了，只能重新登录 */
  sessionExpired?: boolean;
  syncDisabled?: boolean;
  sortMode: SortMode;
  onSortChange(m: SortMode): void;
  onOpenPdf(path: string): void;
  /** v0.11.1：文件树/抽屉现在显示全部文件（对齐 Obsidian） */
  allFiles?: string[];
  /** v0.11.1：点开既不是笔记也不是 PDF 的文件 */
  onOpenAttachment?(path: string): void;
  /**
   * v0.11.0：手机上现在也能**在应用里**看 PDF。
   * 此前安卓只有「交给系统应用打开」一条路（WebView 不内嵌 PDF），
   * 而应用内部存储的库连这条路都没有——点了什么都不发生。
   */
  /** v0.11.10：`.base` 表格视图（手机上同样能开，不再只能"交给 Obsidian"） */
  baseDoc?: { path: string; text: string } | null;
  /**
   * v0.11.15：喂给 `.base` 的是**库里的全部文件**（含图片 / PDF / 别的 .base），
   * 不再只是笔记——非笔记的 content 是空串，靠 file.* 那组属性参与筛选。
   */
  baseNotes?: BaseNote[];
  onCloseBase?(): void;
  onOpenBaseExternal?(path: string): void;
  pdfView?: string | null;
  pdfPath?: string | null;
  onClosePdf?(): void;
  onOpenPdfExternal?(path: string): void;
  onInsertImage?: (notePath: string | null) => Promise<string | null>;
  resolveImage?: (rel: string) => Promise<string | null>;
}

/** 底部常驻格式条的按钮。与桌面编辑器共用同一批 key（见 MarkdownEditor 的 TOOLS） */
const FORMATS: Omit<FormatAction, 'run'>[] = [
  { key: 'h', icon: 'heading', title: '标题' },
  { key: 'b', icon: 'bold', title: '加粗' },
  { key: 'i', icon: 'italic', title: '斜体' },
  { key: 'ul', icon: 'list-ul', title: '无序列表' },
  { key: 'ol', icon: 'list-ol', title: '有序列表' },
  { key: 'task', icon: 'task', title: '任务' },
  { key: 'q', icon: 'quote', title: '引用' },
  { key: 'code', icon: 'code', title: '代码' },
  { key: 'link', icon: 'link', title: '链接' },
  { key: 'image', icon: 'image', title: '插入图片' },
];

/** 文件/文件夹长按操作菜单状态 */
interface SheetState {
  kind: 'file' | 'dir' | 'pdf';
  path: string;
  name: string;
}

export function MobileView(props: Props) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  /** v0.10.0：视图模式提到这里——顶栏要显示它，底部格式条要按它决定给不给 */
  const [mode, setMode] = useState<'edit' | 'read'>('edit');
  /*
   * v0.11.13：格式条不再由一个常驻按钮开关，而是**编辑器一拿到焦点就出现**
   * （Obsidian 是键盘弹起时出现，一个意思）。
   *
   * 当初做成显式开关的理由是"WebView 里检测键盘不可靠"——那是对的，但键盘不等于
   * 焦点：`focusin` / `focusout` 在 WebView 里是可靠的，而"光标在正文里"正是
   * 格式条唯一有用的时刻。省下来的那个位置给了大纲与同步（用户：底部三个都不是高频的）。
   */
  const [editorFocused, setEditorFocused] = useState(false);
  const formatOpen = editorFocused && mode === 'edit';
  /** 编辑器交出来的「按 key 施加格式」入口 */
  const [applyFormat, setApplyFormat] = useState<((key: string) => void) | null>(null);
  /*
   * **必须是稳定引用**。编辑器那个 exposeFormat 的 effect 依赖它，内联箭头
   * 每次渲染都是新函数 → effect 重跑 → setApplyFormat 换成新的回调 → 再渲染，
   * 永远停不下来（v0.10.7 桌面接这条线时当场撞上：整个测试进程挂死）。
   */
  const exposeFormat = useCallback((fn: ((key: string) => void) | null) => {
    setApplyFormat(() => fn);
  }, []);
  /** 当前打开的底部菜单：note=笔记动作 / app=应用与账号 / vault=库 / sort=排序 */
  const [menu, setMenu] = useState<'note' | 'app' | 'vault' | 'sort' | null>(null);
  const [query, setQuery] = useState('');
  const [sheet, setSheet] = useState<SheetState | null>(null); // P1 长按菜单
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('ivnote.collapsed') ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const [showOutline, setShowOutline] = useState(false); // P6 大纲浮层
  /*
   * v0.11.15：**手点同步要有回执。**
   *
   * 用户原话：「手机端底部的最右边的按钮是干什么的？点了之后看不到反应啊，
   * 也没个动效，也没有反应」。三件事都缺：
   *   ① 没登录时同步引擎第一行就 return（现在改成去登录，见下面 onSync）；
   *   ② 转圈的 class 早就写了，但 `.m-nav-btn.spin` 在 CSS 里**根本不存在**；
   *   ③ 同步完只有"有变更"才弹 toast——多数时候确实没变更，于是安静得像坏了。
   * 这里补第三件：只对**人点的那一次**给回执，自动同步照旧安静。
   */
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const syncTapped = useRef(false);
  const wasSyncing = useRef(false);
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null); // P1 内联重命名
  const mainRef = useRef<HTMLElement | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  const toggleDir = (dir: string) => {
    setCollapsedDirs((s) => {
      const n = new Set(s);
      if (n.has(dir)) n.delete(dir);
      else n.add(dir);
      localStorage.setItem('ivnote.collapsed', JSON.stringify([...n]));
      return n;
    });
  };

  /** 全部折叠：把树里出现过的目录一次性收起来 */
  const collapseAll = () => {
    const dirs = new Set<string>(props.emptyDirs ?? []);
    for (const f of props.files) {
      const parts = f.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    setCollapsedDirs((cur) => {
      const n = new Set(cur);
      for (const d of dirs) n.add(d);
      localStorage.setItem('ivnote.collapsed', JSON.stringify([...n]));
      return n;
    });
  };

  /**
   * 四个底部菜单的内容。分组不是装饰——十几个动作平铺成一列时，
   * 人根本扫不出哪些是一类（这正是我们旧「长按操作单」只有三行还显得乱的原因）。
   */
  const buildMenu = (which: 'note' | 'app' | 'vault' | 'sort'): SheetItem[][] => {
    const cur = props.currentPath;
    if (which === 'sort') {
      return [[
        { key: 'name', icon: 'sort', label: '按名称', checked: props.sortMode === 'name', onClick: () => props.onSortChange('name') },
        { key: 'mtime', icon: 'sort', label: '按修改时间', checked: props.sortMode === 'mtime', onClick: () => props.onSortChange('mtime') },
      ]];
    }
    if (which === 'vault') {
      // 库列表排在最上面：这张菜单是从库名旁边那个 ∨ 点开的，用户来这儿就是为了换库
      const list: SheetItem[] = props.vaults.map((v) => ({
        key: `vault-${v.id}`,
        icon: 'folder',
        label: v.name,
        checked: v.id === props.activeVaultId,
        onClick: () => props.onSwitchVault(v.id),
      }));
      return [
        ...(list.length > 0 ? [list] : []),
        [{ key: 'new-vault', icon: 'plus', label: '新建笔记库', onClick: props.onCreateVault }],
        [{ key: 'tags', icon: 'tag', label: '标签', onClick: () => props.onOpenTags?.() }],
      ];
    }
    if (which === 'app') {
      const second: SheetItem[] = [];
      if (props.onOpenSettings) {
        second.push({ key: 'settings', icon: 'settings', label: '设置', onClick: props.onOpenSettings });
      }
      if (props.onCheckUpdate) second.push({ key: 'update', icon: 'sync', label: '检查更新', onClick: props.onCheckUpdate });
      second.push(
        props.hasAccount
          ? { key: 'logout', icon: 'close', label: '退出登录', onClick: props.onLogout }
          : { key: 'login', icon: 'sync', label: '登录同步', onClick: props.onOpenLogin }
      );
      const syncGroup: SheetItem[] = [
        {
          key: 'sync',
          icon: 'sync',
          label: props.syncDisabled ? '登录后可同步' : '立即同步',
          disabled: props.syncing,
          onClick: props.syncDisabled ? props.onOpenLogin : props.onSync,
        },
      ];
      // 冲突和同步状态在手机上此前既看不见也点不到——而"两台设备同时改了同一篇"
      // 正是多端同步最常撞上的事
      if (!props.syncDisabled && (props.conflictCount ?? 0) > 0 && props.onOpenConflicts) {
        syncGroup.push({
          key: 'conflicts',
          icon: 'alert',
          label: `${props.conflictCount} 个冲突待处理`,
          danger: true,
          onClick: props.onOpenConflicts,
        });
      }
      if (!props.syncDisabled && props.onOpenSyncStatus) {
        syncGroup.push({
          key: 'sync-status',
          icon: 'outline',
          label: '同步状态（哪些还没上去）',
          onClick: props.onOpenSyncStatus,
        });
      }
      syncGroup.push({
        key: 'theme',
        icon: props.theme === 'light' ? 'moon' : 'sun',
        label: props.theme === 'light' ? '深色主题' : '浅色主题',
        onClick: props.onToggleTheme,
      });
      return [syncGroup, second];
    }
    /*
     * v0.10.3：「更多」里必须能到设置。
     * 手机上设置此前**只在抽屉顶部那个齿轮下面**——而顶栏右上角的「更多」才是
     * 所有人第一反应会点的地方，它却只有当前笔记的增删改。于是"存储位置在哪""怎么
     * 开同步"在手机上等于不存在。设置单独成组放在最后：它是应用级的，不属于这篇笔记。
     */
    const appGroup: SheetItem[] = props.onOpenSettings
      ? [{ key: 'settings', icon: 'settings', label: '设置', onClick: props.onOpenSettings }]
      : [];
    if (!cur) {
      return [
        [{ key: 'new', icon: 'file-plus', label: '新建笔记', onClick: props.onCreateNote }],
        appGroup,
      ];
    }
    const fileActions: SheetItem[] = [
      {
        key: 'rename',
        icon: 'edit',
        label: '重命名',
        onClick: () => setRenaming({ path: cur, value: cur.split('/').pop()?.replace(/\.(md|markdown)$/i, '') ?? '' }),
      },
    ];
    if (props.onRequestMove) {
      fileActions.push({ key: 'move', icon: 'move', label: '移动到…', onClick: () => props.onRequestMove?.(cur, false) });
    }
    fileActions.push({ key: 'del', icon: 'trash', label: '删除', danger: true, onClick: () => props.onDeleteFile(cur) });
    // v0.10.2：不再有「阅读视图 / 编辑视图」两条——顶栏右边那个图标就是这个开关，
    // 一个模式在一屏里有两个切换入口，只会让人怀疑自己按错了地方
    return [
      [{ key: 'outline', icon: 'outline', label: '大纲', disabled: headings.length === 0, onClick: () => setShowOutline(true) }],
      fileActions,
      appGroup,
    ];
  };

  /**
   * v0.10.2：**长按侧栏条目的操作单**。
   *
   * `setSheet` 从 P1 起就在长按时被调用，但这个 state **从来没有被渲染过**——
   * 它只参与 layersOpen 的 hash 栈，于是手机上长按文件/文件夹什么都不会发生，
   * 侧栏里既没有"移动到…"也没有重命名。手机没有 HTML5 拖放，这张单子就是
   * 移动文件的**唯一**入口，它不在，"侧边栏没法移动文件"就是字面事实。
   */
  const buildSheet = (st: SheetState): SheetItem[][] => {
    const isDir = st.kind === 'dir';
    const groups: SheetItem[][] = [];
    if (st.kind === 'pdf') {
      return [[{ key: 'open', icon: 'file', label: '打开', onClick: () => props.onOpenPdf(st.path) }]];
    }
    if (isDir) {
      groups.push([
        { key: 'newnote', icon: 'file-plus', label: '在此新建笔记', onClick: () => props.onCreateNote() },
        { key: 'newdir', icon: 'folder-plus', label: '在此新建子文件夹', onClick: () => props.onCreateFolder?.(st.path) },
      ]);
    } else {
      groups.push([
        { key: 'open', icon: 'file', label: '打开', onClick: () => props.onSelect(st.path) },
        {
          key: 'rename',
          icon: 'edit',
          label: '重命名',
          onClick: () => setRenaming({ path: st.path, value: st.name.replace(/\.(md|markdown)$/i, '') }),
        },
      ]);
    }
    if (props.onRequestMove) {
      groups.push([
        {
          key: 'move',
          icon: 'move',
          label: isDir ? '把这个文件夹移动到…' : '移动到…',
          onClick: () => props.onRequestMove?.(st.path, isDir),
        },
      ]);
    }
    if (!isDir) {
      groups.push([
        { key: 'del', icon: 'trash', label: '删除', danger: true, onClick: () => props.onDeleteFile(st.path) },
      ]);
    }
    return groups;
  };

  // 打开笔记后自动收起抽屉
  useEffect(() => {
    if (props.currentPath) setDrawerOpen(false);
  }, [props.currentPath]);

  // ---- v0.7.3 P3：Android 返回键逐级回退（history hash 栈）----
  // 每开一层 UI push 一个 hash；返回键/浏览器后退触发 hashchange 关闭最上层。
  const layersOpen = [
    drawerOpen && 'drawer',
    showOutline && 'outline',
    !!sheet && 'sheet',
    !!renaming && 'rename',
  ].filter(Boolean) as string[];

  useEffect(() => {
    const target = layersOpen.length > 0 ? `#${layersOpen[layersOpen.length - 1]}` : '';
    if (location.hash !== target) history.pushState(null, '', target || location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawerOpen, showOutline, sheet, renaming]);

  useEffect(() => {
    const onPop = () => {
      setSheet(null);
      setShowOutline(false);
      setRenaming(null);
      setDrawerOpen(false);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // ---- v0.7.3 P3：主区右滑呼出抽屉 ----
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = touchStart.current;
    touchStart.current = null;
    if (!s || drawerOpen) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (dx > 64 && Math.abs(dy) < 48 && s.x < 56) setDrawerOpen(true); // 左缘起手右滑
  };
  const report = props.lastReport;
  const hasError = report && report.errors.length > 0;
  /** 自动同步撞上网络不通：引擎把错误吞掉只留这个标记，见下面那条 m-offline */
  const offline = !!report?.offline && !hasError;

  /* v0.8.3 的全文搜索、v0.5.0 的文件树渲染，v0.10.0 起都搬进了 ui/mobile/Drawer。
     这里只留状态（query / collapsedDirs），渲染归组件。 */

  // 外部灌词：填进搜索框并把抽屉推出来，否则用户点完标签什么也看不见
  const seedN = props.searchSeed?.n;
  const seedText = props.searchSeed?.text;
  useEffect(() => {
    if (seedN === undefined || seedText === undefined) return;
    setQuery(seedText);
    setDrawerOpen(true);
  }, [seedN, seedText]);

  useEffect(() => {
    if (props.syncing) {
      wasSyncing.current = true;
      return;
    }
    if (!wasSyncing.current) return;
    wasSyncing.current = false;
    if (!syncTapped.current) return; // 自动同步不打扰
    syncTapped.current = false;
    const r = props.lastReport;
    if (r && r.errors.length > 0) return; // 错误有自己的红条，别再叠一层
    const moved = r ? r.pushed + r.pulled : 0;
    setSyncNote(moved > 0 ? `已同步 ↑${r!.pushed} ↓${r!.pulled}` : r?.offline ? '离线，联网后自动同步' : '已是最新');
    const t = window.setTimeout(() => setSyncNote(null), 2200);
    return () => window.clearTimeout(t);
  }, [props.syncing, props.lastReport]);

  // ---- P6：大纲数据 ----
  const headings = useMemo(() => extractHeadings(props.doc ?? ''), [props.doc]);

  /** 编辑器滚动到指定 offset（走 CodeMirror 实例，通过自定义事件桥接） */
  const jumpToOffset = (offset: number) => {
    setShowOutline(false);
    window.dispatchEvent(new CustomEvent('ivnote-jump', { detail: offset }));
  };

  /** P4：阅读模式里点击图片 → 全屏预览（事件委托在 MarkdownEditor 内 emit） */

  /* 文件树渲染已搬进 ui/mobile/Drawer（带层级引导线）。 */

  /* 旧的 .m-sheet 长按操作单由 ui/mobile/Sheet 取代（分组卡片 + 图标）。 */

  const commitRename = () => {
    if (renaming && renaming.value.trim()) props.onRenameFile(renaming.path, renaming.value.trim());
    setRenaming(null);
  };

  /** 重命名弹层。沿用 Sheet 的观感：从底部推上来的一张卡 */
  const renameEl = renaming ? (
    <div className="m-sheet-mask" onClick={() => setRenaming(null)}>
      <div className="m-sheet2" onClick={(e) => e.stopPropagation()}>
        <div className="m-sheet2-grip" aria-hidden="true" />
        <div className="m-sheet2-title">重命名</div>
        <div className="m-sheet2-group" style={{ padding: '10px 12px' }}>
          <input
            className="m-rename-input"
            value={renaming.value}
            autoFocus
            onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && commitRename()}
          />
        </div>
        <div className="m-sheet2-group">
          <button className="m-sheet2-item" onClick={commitRename}>
            <span className="m-sheet2-ico">
              <RibbonIcon name="check" size={20} />
            </span>
            <span className="m-sheet2-label">确定</span>
          </button>
          <button className="m-sheet2-item" onClick={() => setRenaming(null)}>
            <span className="m-sheet2-ico">
              <RibbonIcon name="close" size={20} />
            </span>
            <span className="m-sheet2-label">取消</span>
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div
      className={`m-app ${drawerOpen ? 'drawer-open' : ''} ${formatOpen ? 'format-open' : ''}`}
      /*
       * 焦点进出编辑器 → 格式条显隐。用 focusin/focusout 委托在根上，
       * 不用给 MarkdownEditor 新增回调；点格式条上的按钮时它自己
       * `onPointerDown` 阻止了抢焦点，所以不会把自己关掉。
       */
      onFocus={(e) => {
        if ((e.target as HTMLElement).closest?.('.cm-content')) setEditorFocused(true);
      }}
      onBlur={(e) => {
        if ((e.target as HTMLElement).closest?.('.cm-content')) setEditorFocused(false);
      }}
    >
      <Drawer
        open={drawerOpen}
        vaultName={props.vault.name}
        files={props.files}
        pdfs={props.pdfs}
        allFiles={props.allFiles}
        /* 点开图片/附件同样收起抽屉——和点笔记、点 PDF 一致；
           图片是全屏看的，抽屉留在底下只会在关掉图片后显得莫名其妙 */
        onOpenAttachment={(p) => {
          props.onOpenAttachment?.(p);
          setDrawerOpen(false);
        }}
        emptyDirs={props.emptyDirs ?? []}
        currentPath={props.currentPath}
        collapsedDirs={collapsedDirs}
        query={query}
        searchDocs={props.searchDocs}
        onQuery={setQuery}
        onToggleDir={toggleDir}
        onSelect={(p) => {
          props.onSelect(p);
          setDrawerOpen(false);
        }}
        onOpenPdf={(p) => {
          props.onOpenPdf(p);
          setDrawerOpen(false);
        }}
        onLongPress={(kind, path, name) => setSheet({ kind, path, name })}
        onCreateNote={() => {
          props.onCreateNote();
          setDrawerOpen(false);
        }}
        onCreateFolder={() => props.onCreateFolder?.('')}
        onSort={() => setMenu('sort')}
        onCollapseAll={collapseAll}
        onVaultMenu={() => setMenu('vault')}
        onSettings={() => setMenu('app')}
        onClose={() => setDrawerOpen(false)}
      />

      {/*
        v0.11.14：**顶栏在滚动容器外面。**

        v0.11.13 把滚动交给 `.m-main` 是对的（标题该跟着正文走），但顶栏当时还
        渲染在 `.m-main` **里面**——滚的是包含顶栏的那一层，于是图标栏一起划走了，
        想点左上角的侧栏按钮得先滚回最顶（用户原话）。
        顶栏提出来当 `.m-app` 的直接子元素，`.m-app` 改成纵向 flex：
        第一层 UI 钉住，标题与正文在下面那层滚。这也是 Obsidian 移动端的分层。
      */}
      <TopBar
        path={props.currentPath}
        vaultName={props.vault.name}
        mode={mode}
        syncing={props.syncing}
        onOpenDrawer={() => setDrawerOpen(true)}
        onToggleMode={() => setMode(mode === 'edit' ? 'read' : 'edit')}
        onMore={() => setMenu('note')}
      />

      {/* 主区 */}
      <main className="m-main" ref={mainRef} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        {/*
          登录过期要给**出路**，不能只把服务端那句原话贴出来。
          手机端 2026-09-08 就卡在「拉取失败：refresh token 无效或已过期」这条红条上：
          说的是实情，但用户既不知道该做什么，界面上也没有能点的地方。
        */}
        {props.sessionExpired ? (
          <div className="m-error m-error-action">
            <span>⚠ 登录已过期，笔记不会丢</span>
            <button className="btn small" onClick={props.onOpenLogin}>
              重新登录
            </button>
          </div>
        ) : hasError ? (
          <div className="m-error">⚠ {report!.errors[0]}</div>
        ) : (
          /*
           * v0.11.14：**连不上服务器不再是一条红条。**
           *
           * 手机上「网络这一刻不通」是常态：刚解锁、切回前台、VPN 在重连——
           * 而自动同步恰好在启动 2s / 每次切回前台 / 每 60s 各跑一次。此前每撞上
           * 一次就把「拉取失败：连不上服务器（Failed to fetch）+ 三条排查提示」
           * 整段贴在正文上方，直到下一次成功才消失（用户：「偶尔的这个报错是怎么回事」）。
           * 那三条提示是给"服务端装错了"准备的，对一次网络抖动毫无意义。
           * 现在自动同步撞上网络错误只留这一行，联网后自己就没了；
           * 手动点同步仍然给完整的红条与排查提示（那时人就是来看原因的）。
           */
          offline && <div className="m-offline">离线，联网后自动同步</div>
        )}

        {props.baseDoc ? (
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
        ) : props.pdfView ? (
          <PdfViewer
            url={props.pdfView}
            path={props.pdfPath ?? ''}
            onClose={() => props.onClosePdf?.()}
            onOpenExternal={
              props.onOpenPdfExternal && props.pdfPath
                ? () => props.onOpenPdfExternal?.(props.pdfPath!)
                : undefined
            }
          />
        ) : props.currentPath == null ? (
          <div className="m-empty">
            <img src={logoUrl} alt="" className="login-logo" />
            <p>左上角打开文件列表，或新建一篇</p>
            <button className="btn primary" onClick={props.onCreateNote}>
              新建笔记
            </button>
          </div>
        ) : (
          <>
            <InlineTitle path={props.currentPath} doc={props.doc} onRename={props.onRenameFile} />
            <MarkdownEditor
              mobile
              doc={props.doc ?? ''}
              onEdit={props.onEdit}
              currentPath={props.currentPath}
              theme={props.theme}
              mode={mode}
              onModeChange={setMode}
              exposeFormat={exposeFormat}
              onInsertImage={props.onInsertImage}
              resolveImage={props.resolveImage}
              onOpenPath={props.onOpenPath}
            />
            {/* P5：反向链接区块 */}
            <BacklinksSection backlinks={props.backlinks ?? []} onSelect={props.onSelect} />
          </>
        )}

        {syncNote ? (
          <div className="m-toast">{syncNote}</div>
        ) : (
          report && !hasError && (report.pushed > 0 || report.pulled > 0) && (
            <div className="m-toast">
              ↑{report.pushed} ↓{report.pulled}
              {report.conflicts.length > 0 && ` · 冲突${report.conflicts.length}`}
            </div>
          )
        )}
      </main>

      <BottomBar
        formatOpen={formatOpen}
        formatAvailable={props.currentPath != null && mode === 'edit' && !!applyFormat}
        formats={FORMATS.map((f) => ({ ...f, run: () => applyFormat?.(f.key) }))}
        onSearch={() => {
          setDrawerOpen(true);
          // 抽屉一开就把焦点放进搜索框，少一次点击
          window.setTimeout(() => document.querySelector<HTMLInputElement>('.m-dr-search input')?.focus(), 120);
        }}
        onCreate={props.onCreateNote}
        onOutline={() => setShowOutline(true)}
        outlineAvailable={headings.length > 0}
        onSync={() => {
          // 没登录时这颗键的意思是"去登录"——它此前调的是一个第一行就 return 的函数
          if (props.syncDisabled) {
            props.onOpenLogin();
            return;
          }
          syncTapped.current = true;
          props.onSync();
        }}
        syncing={props.syncing}
        syncDisabled={props.syncDisabled}
      />

      <Sheet
        open={menu !== null}
        groups={menu === null ? [] : buildMenu(menu)}
        onClose={() => setMenu(null)}
      />

      {/* 长按侧栏条目的操作单（v0.10.2 前建了 state 却忘了渲染） */}
      <Sheet
        open={sheet !== null}
        title={sheet?.name}
        groups={sheet === null ? [] : buildSheet(sheet)}
        onClose={() => setSheet(null)}
      />


      {/* P6：大纲浮层 */}
      {showOutline && (
        /*
         * v0.11.13：大纲改成和底部菜单**同一套形状**——贴着底边、上面两角圆、
         * 顶上一条把手。此前它是 `.m-outline`：直角、且位置由外层 flex 决定，
         * 于是浮在半空中（用户：「大纲的弹窗是直角且位置不对」）。
         * 同一个应用里两种弹层形状，只会让人觉得是两个应用。
         */
        <div className="m-sheet-mask" onClick={() => setShowOutline(false)}>
          <div
            className="m-sheet2 m-outline2"
            role="dialog"
            aria-label="大纲"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="m-sheet2-grip" aria-hidden="true" />
            <div className="m-sheet2-title">大纲</div>
            <div className="m-sheet2-scroll">
              <div className="m-sheet2-group">
                {headings.map((h, i) => (
                  <button
                    key={i}
                    className="m-sheet2-item m-outline-item"
                    style={{ paddingLeft: `${(h.level - 1) * 14 + 16}px` }}
                    onClick={() => jumpToOffset(h.offset)}
                  >
                    <span className="m-sheet2-label">{h.text}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* P4：图片全屏预览（由 MarkdownEditor 内部打开，见 viewerImg 桥） */}

      {renameEl}

      {/* v0.7.3 P4：图片全屏预览（lightbox，点任意处关闭） */}
    </div>
  );
}

/**
 * v0.7.3 P5：文末反向链接区块。
 * 数据由 App 层算好传入（复用 searchDocs 缓存），本组件只负责渲染与跳转。
 */
export function BacklinksSection(props: {
  backlinks: string[];
  onSelect(path: string): void;
}) {
  if (props.backlinks.length === 0) return null;
  return (
    <div className="m-backlinks">
      <div className="m-backlinks-title">
        <RibbonIcon name="backlink" size={15} />
        {props.backlinks.length} 条反向链接
      </div>
      {props.backlinks.map((p) => (
        <button key={p} className="m-backlink-item" onClick={() => props.onSelect(p)}>
          {(p.split('/').pop() ?? p).replace(/\.(md|markdown)$/i, '')}
          <span className="m-backlink-path">{p}</span>
        </button>
      ))}
    </div>
  );
}


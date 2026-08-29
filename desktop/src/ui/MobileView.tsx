/**
 * 移动端视图（v0.7.3 大改）：触屏优先的单栏布局，对标原生笔记 App 手感。
 * - 顶栏：抽屉开关 + 笔记名 + 同步；大标题行
 * - 抽屉：折叠树 + 长按操作菜单（删除/重命名）+ 搜索 + 排序
 * - 手势：主区右滑呼出抽屉；Android 返回键逐级回退（气泡→大纲→图片→抽屉→无）
 * - 主区：CodeMirror 编辑器 + 选区气泡工具栏 + 大纲浮层 + 图片全屏预览 + 反链区块
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import logoUrl from '../assets/logo.png';
import type { SearchDoc } from '../lib/searchIndex';
import { RibbonIcon } from './Icons';
import { MarkdownEditor } from './MarkdownEditor';
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
  vaultSelector: React.ReactNode;
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
  onCreateVault(): void;
  onToggleTheme(): void;
  theme: 'light' | 'dark';
  onLogout(): void;
  hasAccount: boolean;
  onOpenLogin(): void;
  syncDisabled?: boolean;
  sortMode: SortMode;
  onSortChange(m: SortMode): void;
  onOpenPdf(path: string): void;
  onInsertImage?: () => Promise<string | null>;
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
  const [formatOpen, setFormatOpen] = useState(false);
  /** 编辑器交出来的「按 key 施加格式」入口 */
  const [applyFormat, setApplyFormat] = useState<((key: string) => void) | null>(null);
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
      return [
        [{ key: 'new-vault', icon: 'plus', label: '新建笔记库', onClick: props.onCreateVault }],
        [{ key: 'tags', icon: 'tag', label: '标签', onClick: () => props.onOpenTags?.() }],
      ];
    }
    if (which === 'app') {
      const second: SheetItem[] = [];
      if (props.onCheckUpdate) second.push({ key: 'update', icon: 'sync', label: '检查更新', onClick: props.onCheckUpdate });
      second.push(
        props.hasAccount
          ? { key: 'logout', icon: 'close', label: '退出登录', onClick: props.onLogout }
          : { key: 'login', icon: 'sync', label: '登录同步', onClick: props.onOpenLogin }
      );
      return [
        [
          {
            key: 'sync',
            icon: 'sync',
            label: props.syncDisabled ? '登录后可同步' : '立即同步',
            disabled: props.syncing,
            onClick: props.syncDisabled ? props.onOpenLogin : props.onSync,
          },
          {
            key: 'theme',
            icon: props.theme === 'light' ? 'moon' : 'sun',
            label: props.theme === 'light' ? '深色主题' : '浅色主题',
            onClick: props.onToggleTheme,
          },
        ],
        second,
      ];
    }
    if (!cur) return [[{ key: 'new', icon: 'file-plus', label: '新建笔记', onClick: props.onCreateNote }]];
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
    return [
      [
        { key: 'read', icon: 'book', label: '阅读视图', checked: mode === 'read', onClick: () => setMode('read') },
        { key: 'edit', icon: 'edit', label: '编辑视图', checked: mode === 'edit', onClick: () => setMode('edit') },
      ],
      [{ key: 'outline', icon: 'outline', label: '大纲', disabled: headings.length === 0, onClick: () => setShowOutline(true) }],
      fileActions,
    ];
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
    <div className={`m-app ${drawerOpen ? 'drawer-open' : ''} ${formatOpen ? 'format-open' : ''}`}>
      <Drawer
        open={drawerOpen}
        vaultName={props.vault.name}
        files={props.files}
        pdfs={props.pdfs}
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

      {/* 主区 */}
      <main className="m-main" ref={mainRef} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <TopBar
          path={props.currentPath}
          vaultName={props.vault.name}
          mode={mode}
          syncing={props.syncing}
          onOpenDrawer={() => setDrawerOpen(true)}
          onToggleMode={() => setMode(mode === 'edit' ? 'read' : 'edit')}
          onMore={() => setMenu('note')}
        />
        {hasError && <div className="m-error">⚠ {report!.errors[0]}</div>}

        {props.currentPath == null ? (
          <div className="m-empty">
            <img src={logoUrl} alt="" className="login-logo" />
            <p>左上角打开文件列表，或新建一篇</p>
            <button className="btn primary" onClick={props.onCreateNote}>
              新建笔记
            </button>
          </div>
        ) : (
          <>
            <InlineTitle path={props.currentPath} onRename={props.onRenameFile} />
            <MarkdownEditor
              mobile
              doc={props.doc ?? ''}
              onEdit={props.onEdit}
              currentPath={props.currentPath}
              theme={props.theme}
              mode={mode}
              onModeChange={setMode}
              exposeFormat={(fn) => setApplyFormat(() => fn)}
              onInsertImage={props.onInsertImage}
              resolveImage={props.resolveImage}
            />
            {/* P5：反向链接区块 */}
            <BacklinksSection backlinks={props.backlinks ?? []} onSelect={props.onSelect} />
          </>
        )}

        {report && !hasError && (report.pushed > 0 || report.pulled > 0) && (
          <div className="m-toast">
            ↑{report.pushed} ↓{report.pulled}
            {report.conflicts.length > 0 && ` · 冲突${report.conflicts.length}`}
          </div>
        )}
      </main>

      <BottomBar
        canGoBack={props.currentPath != null}
        formatOpen={formatOpen}
        formatAvailable={props.currentPath != null && mode === 'edit' && !!applyFormat}
        formats={FORMATS.map((f) => ({ ...f, run: () => applyFormat?.(f.key) }))}
        onBack={() => setDrawerOpen(true)}
        onSearch={() => {
          setDrawerOpen(true);
          // 抽屉一开就把焦点放进搜索框，少一次点击
          window.setTimeout(() => document.querySelector<HTMLInputElement>('.m-dr-search input')?.focus(), 120);
        }}
        onCreate={props.onCreateNote}
        onToggleFormat={() => setFormatOpen((v) => !v)}
        onMore={() => setMenu('note')}
      />

      <Sheet
        open={menu !== null}
        groups={menu === null ? [] : buildMenu(menu)}
        onClose={() => setMenu(null)}
      />


      {/* P6：大纲浮层 */}
      {showOutline && (
        <div className="m-sheet-mask" onClick={() => setShowOutline(false)}>
          <div className="m-outline" onClick={(e) => e.stopPropagation()}>
            <div className="m-sheet-title">大纲</div>
            <ul className="m-outline-list">
              {headings.map((h, i) => (
                <li key={i}>
                  <button
                    className="m-sheet-item outline-item"
                    style={{ paddingLeft: `${(h.level - 1) * 14 + 16}px` }}
                    onClick={() => jumpToOffset(h.offset)}
                  >
                    {h.text}
                  </button>
                </li>
              ))}
            </ul>
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


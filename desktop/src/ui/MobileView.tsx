/**
 * 移动端视图（v0.7.3 大改）：触屏优先的单栏布局，对标原生笔记 App 手感。
 * - 顶栏：抽屉开关 + 笔记名 + 同步；大标题行
 * - 抽屉：折叠树 + 长按操作菜单（删除/重命名）+ 搜索 + 排序
 * - 手势：主区右滑呼出抽屉；Android 返回键逐级回退（气泡→大纲→图片→抽屉→无）
 * - 主区：CodeMirror 编辑器 + 选区气泡工具栏 + 大纲浮层 + 图片全屏预览 + 反链区块
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import logoUrl from '../assets/logo.svg';
import { buildFileTree, displayName, type TreeNode } from './FileTree';
import { MarkdownEditor } from './MarkdownEditor';
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
  onDeleteFile(path: string): void;
  /** v0.7.3 P1：重命名 */
  onRenameFile(path: string, newName: string): void;
  /** v0.7.3 P5：当前笔记的反向链接（App 层基于 searchDocs 计算） */
  backlinks?: string[];
  /** 空文件夹（只有 .keep）——搜索时不显示，避免结果里混进空目录 */
  emptyDirs?: string[];
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

/** 文件/文件夹长按操作菜单状态 */
interface SheetState {
  kind: 'file' | 'dir' | 'pdf';
  path: string;
  name: string;
}

export function MobileView(props: Props) {
  const [drawerOpen, setDrawerOpen] = useState(false);
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return props.files;
    return props.files.filter((p) => p.toLowerCase().includes(q));
  }, [props.files, query]);

  const filteredPdfs = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return props.pdfs;
    return props.pdfs.filter((p) => p.toLowerCase().includes(q));
  }, [props.pdfs, query]);

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

  const tree = useMemo(
    () => buildFileTree(filtered, query.trim() ? [] : props.emptyDirs ?? []),
    [filtered, query, props.emptyDirs]
  );
  const report = props.lastReport;
  const hasError = report && report.errors.length > 0;

  // ---- P6：大纲数据 ----
  const headings = useMemo(() => extractHeadings(props.doc ?? ''), [props.doc]);

  /** 编辑器滚动到指定 offset（走 CodeMirror 实例，通过自定义事件桥接） */
  const jumpToOffset = (offset: number) => {
    setShowOutline(false);
    window.dispatchEvent(new CustomEvent('ivnote-jump', { detail: offset }));
  };

  /** P4：阅读模式里点击图片 → 全屏预览（事件委托在 MarkdownEditor 内 emit） */

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    if (node.type === 'dir') {
      const isOpen = !collapsedDirs.has(node.path);
      return (
        <div key={node.path} className="ft-node">
          <div
            className={`m-ft-dir ${isOpen ? 'open' : ''}`}
            style={{ paddingLeft: `${12 + depth * 16}px` }}
            onClick={() => toggleDir(node.path)}
            onContextMenu={(e) => {
              e.preventDefault();
              setSheet({ kind: 'dir', path: node.path, name: node.name });
            }}
          >
            <span className="ft-caret">{isOpen ? '▾' : '▸'}</span>
            <span>{node.name}</span>
          </div>
          {isOpen && node.children?.map((c) => renderNode(c, depth + 1))}
        </div>
      );
    }
    return (
      <div
        key={node.path}
        className={`m-file-row ${props.currentPath === node.path ? 'active' : ''}`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        onClick={() => props.onSelect(node.path)}
        onContextMenu={(e) => {
          e.preventDefault();
          setSheet({ kind: 'file', path: node.path, name: displayName(node.name, true) });
        }}
      >
        <span className="file-name" title={node.name}>
          {displayName(node.name, true)}
        </span>
        <span className="m-file-chev">›</span>
      </div>
    );
  };

  /** P1：底部操作单 */
  const sheetEl = sheet ? (
    <div className="m-sheet-mask" onClick={() => setSheet(null)}>
      <div className="m-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="m-sheet-title">{sheet.name}</div>
        {sheet.kind === 'file' && (
          <>
            <button
              className="m-sheet-item"
              onClick={() => {
                setRenaming({ path: sheet.path, value: sheet.name });
                setSheet(null);
              }}
            >
              ✏️ 重命名
            </button>
            <button
              className="m-sheet-item danger"
              onClick={() => {
                setSheet(null);
                props.onDeleteFile(sheet.path); // App 层已带回收站确认框
              }}
            >
              🗑 删除
            </button>
          </>
        )}
        {sheet.kind === 'pdf' && (
          <button
            className="m-sheet-item"
            onClick={() => {
              setSheet(null);
              props.onOpenPdf(sheet.path);
            }}
          >
            📄 打开 PDF
          </button>
        )}
        {sheet.kind === 'dir' && (
          <button
            className="m-sheet-item"
            onClick={() => {
              setSheet(null);
              toggleDir(sheet.path);
            }}
          >
            📁 展开 / 收起
          </button>
        )}
        <button className="m-sheet-item cancel" onClick={() => setSheet(null)}>
          取消
        </button>
      </div>
    </div>
  ) : null;

  const commitRename = () => {
    if (renaming && renaming.value.trim()) props.onRenameFile(renaming.path, renaming.value.trim());
    setRenaming(null);
  };

  /** P1 重命名：内联输入行（WebView 禁用 window.prompt，血泪禁令） */
  const renameEl = renaming ? (
    <div className="m-sheet-mask" onClick={() => setRenaming(null)}>
      <div className="m-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="m-sheet-title">重命名</div>
        <input
          className="m-search"
          style={{ margin: '0 0 10px' }}
          value={renaming.value}
          autoFocus
          onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && commitRename()}
        />
        <button className="m-sheet-item" onClick={commitRename}>
          确定
        </button>
        <button className="m-sheet-item cancel" onClick={() => setRenaming(null)}>
          取消
        </button>
      </div>
    </div>
  ) : null;

  return (
    <div className={`m-app ${drawerOpen ? 'drawer-open' : ''}`}>
      {/* 遮罩 */}
      <div className="m-mask" onClick={() => setDrawerOpen(false)} />

      {/* 抽屉 */}
      <aside className="m-drawer">
        <div className="m-drawer-head">
          <img src={logoUrl} alt="" className="brand-logo" />
          <span className="brand-name">Ivyea Note</span>
          <button className="icon-btn" onClick={props.onToggleTheme}>
            {props.theme === 'light' ? '🌙' : '☀️'}
          </button>
        </div>

        <div className="vault-row">{props.vaultSelector}</div>
        {props.syncDisabled && (
          <div className="login-hint">
            本地模式：笔记只存在这台设备上，
            <button onClick={props.onOpenLogin}>登录同步</button>
            后可多端同步。
          </div>
        )}

        <input
          className="m-search"
          type="search"
          placeholder="🔍 搜索笔记…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="m-sort-row">
          <span>排序</span>
          <select value={props.sortMode} onChange={(e) => props.onSortChange(e.target.value as SortMode)}>
            <option value="name">按名称</option>
            <option value="mtime">按修改时间</option>
          </select>
        </div>

        <div className="m-file-list">
          {tree.map((n) => renderNode(n, 0))}
          {filteredPdfs.length > 0 && (
            <div className="dir-group">
              <div className="dir-label pdf-label">📄 PDF</div>
              {filteredPdfs.map((p) => (
                <div
                  key={p}
                  className="m-file-row pdf-file"
                  onClick={() => props.onOpenPdf(p)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setSheet({ kind: 'pdf', path: p, name: p.split('/').pop() ?? p });
                  }}
                >
                  <span className="file-name">{p.split('/').pop()}</span>
                </div>
              ))}
            </div>
          )}
          {tree.length === 0 && filteredPdfs.length === 0 && (
            <div className="empty">{query ? '没有匹配的笔记' : '还没有笔记，点下方 ＋ 新建'}</div>
          )}
        </div>

        <div className="sidebar-foot">
          <button onClick={props.onCreateNote}>＋ 新建笔记</button>
          {props.onCheckUpdate && <button onClick={props.onCheckUpdate}>检查更新</button>}
          <button onClick={props.onCreateVault}>＋ 新建笔记库</button>
          {props.hasAccount ? (
            <button onClick={props.onLogout}>退出登录</button>
          ) : (
            <button onClick={props.onOpenLogin}>登录同步</button>
          )}
        </div>
      </aside>

      {/* 主区 */}
      <main className="m-main" ref={mainRef} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <header className="m-topbar">
          <button className="icon-btn" onClick={() => setDrawerOpen(true)} aria-label="打开菜单">
            ☰
          </button>
          <span className="m-title-small">
            {props.currentPath ? props.currentPath.split('/').pop()?.replace(/\.(md|markdown)$/i, '') : props.vault.name}
          </span>
          {/* P6 大纲入口（仅编辑笔记时显示） */}
          {props.currentPath != null && headings.length > 0 && (
            <button className="icon-btn" onClick={() => setShowOutline(true)} aria-label="大纲">
              ≡
            </button>
          )}
          <button
            className={`icon-btn m-sync ${props.syncing ? 'spin' : ''}`}
            onClick={props.onSync}
            disabled={props.syncing || props.syncDisabled}
            title={props.syncDisabled ? '云同步需要登录后可用' : '同步'}
            aria-label="同步"
          >
            ↻
          </button>
        </header>
        {props.currentPath != null && (
          <h1 className="m-large-title" aria-hidden="true">
            <span>
              {props.currentPath.split('/').pop()?.replace(/\.(md|markdown)$/i, '')}
            </span>
          </h1>
        )}

        {hasError && <div className="m-error">⚠ {report!.errors[0]}</div>}

        {props.currentPath == null ? (
          <div className="m-empty">
            <img src={logoUrl} alt="" className="login-logo" />
            <p>从左上角 ☰ 选择一篇笔记</p>
            <button className="btn primary" onClick={props.onCreateNote}>
              ＋ 新建笔记
            </button>
          </div>
        ) : (
          <>
            <MarkdownEditor
              mobile
              doc={props.doc ?? ''}
              onEdit={props.onEdit}
              currentPath={props.currentPath}
              theme={props.theme}
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

      {sheetEl}
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
      <div className="m-backlinks-title">🔗 {props.backlinks.length} 条反向链接</div>
      {props.backlinks.map((p) => (
        <button key={p} className="m-backlink-item" onClick={() => props.onSelect(p)}>
          {displayName(p.split('/').pop() ?? p, true)}
          <span className="m-backlink-path">{p}</span>
        </button>
      ))}
    </div>
  );
}


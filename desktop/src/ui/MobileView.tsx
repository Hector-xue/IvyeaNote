/**
 * 移动端视图：触屏优先的单栏布局。
 * - 顶栏：抽屉开关 + 当前笔记名 + 同步状态
 * - 抽屉：笔记库切换、搜索框、文件列表、新建/退出
 * - 主区：Markdown 轻编辑（textarea，移动端输入法友好；重度编辑回桌面）
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import logoUrl from '../assets/logo.svg';
import { buildTree } from './MainView';
import type { VaultMeta } from '../lib/store';
import type { SyncReport } from '../lib/sync';

interface Props {
  vault: VaultMeta;
  files: string[];
  currentPath: string | null;
  doc: string | null;
  syncing: boolean;
  lastReport: SyncReport | null;
  vaultSelector: React.ReactNode;
  onSelect(path: string): void;
  onEdit(path: string, text: string): void;
  onCreateNote(): void;
  onDeleteFile(path: string): void;
  onSync(): void;
  onCreateVault(): void;
  onToggleTheme(): void;
  theme: 'light' | 'dark';
  onLogout(): void;
  /** 是否已登录（未登录=本地模式，显示「登录同步」而非「退出登录」） */
  hasAccount: boolean;
  onOpenLogin(): void;
}

export function MobileView(props: Props) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return props.files;
    return props.files.filter((p) => p.toLowerCase().includes(q));
  }, [props.files, query]);

  // 打开笔记后自动收起抽屉
  useEffect(() => {
    if (props.currentPath) setDrawerOpen(false);
  }, [props.currentPath]);

  const tree = buildTree(filtered);
  const report = props.lastReport;
  const hasError = report && report.errors.length > 0;

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

        <input
          className="m-search"
          type="search"
          placeholder="🔍 搜索笔记…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="m-file-list">
          {[...tree.entries()].map(([dir, nodes]) => (
            <div key={dir || '/'} className="dir-group">
              {dir && <div className="dir-label">▸ {dir}</div>}
              {nodes.map((n) => (
                <div
                  key={n.path}
                  className={`file ${props.currentPath === n.path ? 'active' : ''}`}
                  onClick={() => props.onSelect(n.path)}
                >
                  <span className="file-name">{n.name}</span>
                  <button
                    className="file-del"
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onDeleteFile(n.path);
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="empty">{query ? '没有匹配的笔记' : '还没有笔记，点下方 ＋ 新建'}</div>
          )}
        </div>

        <div className="sidebar-foot">
          <button onClick={props.onCreateNote}>＋ 新建笔记</button>
          <button onClick={props.onCreateVault}>＋ 新建笔记库</button>
          {props.hasAccount ? (
            <button onClick={props.onLogout}>退出登录</button>
          ) : (
            <button onClick={props.onOpenLogin}>登录同步</button>
          )}
        </div>
      </aside>

      {/* 主区 */}
      <main className="m-main">
        <header className="m-topbar">
          <button className="icon-btn" onClick={() => setDrawerOpen(true)} aria-label="打开菜单">
            ☰
          </button>
          <span className="m-title">{props.currentPath ?? props.vault.name}</span>
          <button
            className={`icon-btn m-sync ${props.syncing ? 'spin' : ''}`}
            onClick={props.onSync}
            disabled={props.syncing}
            aria-label="同步"
          >
            ↻
          </button>
        </header>

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
          <textarea
            ref={taRef}
            className="m-editor"
            value={props.doc ?? ''}
            onChange={(e) => props.onEdit(props.currentPath!, e.target.value)}
            placeholder="开始书写…"
            spellCheck={false}
          />
        )}

        {report && !hasError && (report.pushed > 0 || report.pulled > 0) && (
          <div className="m-toast">
            ↑{report.pushed} ↓{report.pulled}
            {report.conflicts.length > 0 && ` · 冲突${report.conflicts.length}`}
          </div>
        )}
      </main>
    </div>
  );
}

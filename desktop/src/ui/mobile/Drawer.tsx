/**
 * 移动端文件浏览器抽屉（v0.10.0）。
 *
 * 照 Obsidian 移动端的信息架构，自上而下：
 *   库名（可切库） · 设置
 *   N 个文件，M 个文件夹
 *   一行图标动作（新建笔记 / 新建文件夹 / 排序 / 全部折叠 / 关闭）
 *   搜索
 *   文件树（带层级引导线）
 *
 * 之前这里是：库选择 `<select>`、一整段「本地模式…」说明散文、搜索框、
 * 一个原生排序 `<select>`（点开是安卓系统对话框）、扁平列表、
 * 底部五个文字按钮（新建笔记 / 新建文件夹 / 检查更新 / 新建笔记库 / 登录同步）。
 * 功能没少，但它读起来像一个设置页，不像一个文件浏览器。
 */
import { useMemo, useRef } from 'react';
import { RibbonIcon } from '../Icons';
import { buildFileTree, displayName, type TreeNode } from '../FileTree';
import { searchNotes, type SearchDoc } from '../../lib/searchIndex';

interface Props {
  open: boolean;
  vaultName: string;
  files: string[];
  pdfs: string[];
  emptyDirs: string[];
  currentPath: string | null;
  collapsedDirs: Set<string>;
  query: string;
  searchDocs?: SearchDoc[];
  onQuery(v: string): void;
  onToggleDir(path: string): void;
  onSelect(path: string): void;
  onOpenPdf(path: string): void;
  onLongPress(kind: 'file' | 'dir' | 'pdf', path: string, name: string): void;
  onCreateNote(): void;
  onCreateFolder(): void;
  onSort(): void;
  onCollapseAll(): void;
  onVaultMenu(): void;
  onSettings(): void;
  onClose(): void;
}

export function Drawer(props: Props) {
  const searching = props.query.trim() !== '' && !!props.searchDocs;
  const hits = useMemo(
    () => (searching ? searchNotes(props.searchDocs!, props.query, 40) : []),
    [searching, props.searchDocs, props.query]
  );
  const tree = useMemo(
    () => buildFileTree(props.files, props.emptyDirs),
    [props.files, props.emptyDirs]
  );
  const dirCount = useMemo(() => {
    const set = new Set(props.emptyDirs);
    for (const f of props.files) {
      const parts = f.split('/');
      for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'));
    }
    return set.size;
  }, [props.files, props.emptyDirs]);

  /**
   * 长按呼出操作单。
   *
   * v0.10.2：**不能只靠 contextmenu**。安卓 WebView 上长按一段文字优先进入
   * 文字选择，`contextmenu` 时有时无——用户的体感就是"长按没反应"，而这张单子
   * 是手机上移动 / 重命名文件的唯一入口。所以自己计时：按住 500ms 不动就算长按，
   * 手指一移动（>10px）或提前松开就取消。contextmenu 仍然保留，两条路都通。
   */
  const pressTimer = useRef<number | undefined>(undefined);
  const pressFrom = useRef<{ x: number; y: number } | null>(null);
  /** 长按已经触发过：随后的 click 不该再把文件打开一次 */
  const pressFired = useRef(false);

  const cancelPress = () => {
    window.clearTimeout(pressTimer.current);
    pressTimer.current = undefined;
    pressFrom.current = null;
  };

  const fire = (kind: 'file' | 'dir' | 'pdf', path: string, name: string) => {
    pressFired.current = true;
    props.onLongPress(kind, path, name);
  };

  const longPressHandlers = (kind: 'file' | 'dir' | 'pdf', path: string, name: string) => ({
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      cancelPress();
      fire(kind, path, name);
    },
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0];
      pressFrom.current = { x: t.clientX, y: t.clientY };
      pressFired.current = false;
      pressTimer.current = window.setTimeout(() => fire(kind, path, name), 500);
    },
    onTouchMove: (e: React.TouchEvent) => {
      const from = pressFrom.current;
      if (!from) return;
      const t = e.touches[0];
      // 滚动列表时手指必然在动，那不是长按
      if (Math.abs(t.clientX - from.x) > 10 || Math.abs(t.clientY - from.y) > 10) cancelPress();
    },
    onTouchEnd: (e: React.TouchEvent) => {
      // 长按已经触发过：吞掉浏览器随后补的那次合成 click
      // （React 里 touchend 不是 passive，preventDefault 有效）
      if (pressFired.current) e.preventDefault();
      cancelPress();
    },
    onTouchCancel: cancelPress,
  });

  /** 长按刚触发过就吞掉这次 click，否则松手瞬间又把笔记打开了 */
  const clickUnlessPressed = (fn: () => void) => () => {
    if (pressFired.current) {
      pressFired.current = false;
      return;
    }
    fn();
  };

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    // 层级引导线：靠左内边距 + 一条竖线，让嵌套关系一眼可见（Obsidian 就是这么画的）
    const pad = { paddingLeft: `${10 + depth * 15}px` };
    if (node.type === 'dir') {
      const open = !props.collapsedDirs.has(node.path);
      return (
        <div key={node.path} className="m-tree-node">
          <div
            className="m-tree-row m-tree-dir"
            style={pad}
            onClick={clickUnlessPressed(() => props.onToggleDir(node.path))}
            {...longPressHandlers('dir', node.path, node.name)}
          >
            <span className="m-tree-caret">
              <RibbonIcon name={open ? 'chevron-down' : 'chevron-right'} size={15} />
            </span>
            <span className="m-tree-name">{node.name}</span>
          </div>
          {open && node.children?.map((c) => renderNode(c, depth + 1))}
        </div>
      );
    }
    return (
      <div
        key={node.path}
        className={`m-tree-row m-tree-file ${props.currentPath === node.path ? 'active' : ''}`}
        style={pad}
        onClick={clickUnlessPressed(() => props.onSelect(node.path))}
        {...longPressHandlers('file', node.path, displayName(node.name, true))}
      >
        <span className="m-tree-name">{displayName(node.name, true)}</span>
      </div>
    );
  };

  return (
    <>
      <div className="m-mask" onClick={props.onClose} />
      <aside className={`m-drawer2 ${props.open ? 'open' : ''}`} aria-label="文件浏览器">
        <div className="m-dr-head">
          <button className="m-dr-vault" onClick={props.onVaultMenu}>
            <span className="m-dr-vault-name">{props.vaultName}</span>
            <RibbonIcon name="chevron-down" size={15} />
          </button>
          <button className="m-dr-icon" onClick={props.onSettings} aria-label="设置">
            <RibbonIcon name="settings" size={19} />
          </button>
        </div>
        <div className="m-dr-count">
          {props.files.length + props.pdfs.length} 个文件，{dirCount} 个文件夹
        </div>

        <div className="m-dr-actions">
          <button className="m-dr-icon" onClick={props.onCreateNote} aria-label="新建笔记">
            <RibbonIcon name="file-plus" size={19} />
          </button>
          <button className="m-dr-icon" onClick={props.onCreateFolder} aria-label="新建文件夹">
            <RibbonIcon name="folder-plus" size={19} />
          </button>
          <button className="m-dr-icon" onClick={props.onSort} aria-label="排序">
            <RibbonIcon name="sort" size={19} />
          </button>
          <button className="m-dr-icon" onClick={props.onCollapseAll} aria-label="全部折叠">
            <RibbonIcon name="collapse" size={19} />
          </button>
          <button className="m-dr-icon" onClick={props.onClose} aria-label="关闭">
            <RibbonIcon name="close" size={19} />
          </button>
        </div>

        <div className="m-dr-search">
          <RibbonIcon name="search" size={16} />
          <input
            value={props.query}
            placeholder="搜索笔记"
            onChange={(e) => props.onQuery(e.target.value)}
          />
          {props.query && (
            <button className="m-dr-clear" onClick={() => props.onQuery('')} aria-label="清空">
              <RibbonIcon name="close" size={15} />
            </button>
          )}
        </div>

        <div className="m-dr-body">
          {searching ? (
            hits.length === 0 ? (
              <p className="m-dr-empty">没有匹配的笔记</p>
            ) : (
              <>
                <div className="m-dr-hint">{hits.length} 篇匹配</div>
                {hits.map((h) => (
                  <button key={h.path} className="m-hit" onClick={() => props.onSelect(h.path)}>
                    <span className="m-hit-title">
                      {displayName(h.path.split('/').pop() ?? h.path, true)}
                    </span>
                    {h.path.includes('/') && (
                      <span className="m-hit-dir">{h.path.slice(0, h.path.lastIndexOf('/'))}</span>
                    )}
                    {h.preview.map((p, i) => (
                      <span key={i} className="m-hit-line">
                        {p.text}
                      </span>
                    ))}
                  </button>
                ))}
              </>
            )
          ) : (
            <>
              {tree.map((n) => renderNode(n, 0))}
              {props.pdfs.length > 0 && (
                <>
                  <div className="m-dr-hint">PDF</div>
                  {props.pdfs.map((p) => (
                    <div
                      key={p}
                      className="m-tree-row m-tree-file"
                      style={{ paddingLeft: '10px' }}
                      onClick={clickUnlessPressed(() => props.onOpenPdf(p))}
                      {...longPressHandlers('pdf', p, p.split('/').pop() ?? p)}
                    >
                      <span className="m-tree-name">{p.split('/').pop()}</span>
                      <span className="m-tree-badge">PDF</span>
                    </div>
                  ))}
                </>
              )}
              {props.files.length === 0 && props.pdfs.length === 0 && (
                <p className="m-dr-empty">还没有笔记，点上面的「新建笔记」开始</p>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}

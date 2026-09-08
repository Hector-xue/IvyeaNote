/**
 * 顶栏（v0.11.4）—— 照 Obsidian 的布局做。
 *
 * # 前三版都错在哪
 *
 * - v0.11.0：删掉系统标题栏，换成一条**什么都不画的 32px 白带** → 「顶栏依旧存在」。
 * - v0.11.1：往里塞品牌标记和笔记路径，想让它"像是设计的一部分" → 「顶栏依旧存在」。
 * - v0.11.3：整条删掉，三颗按钮浮在右上角 → 「顶部怪怪的」「按钮突兀」「**窗口拖不动了**」。
 *
 * 三次都在同一个问题上打转，而用户每次都在说同一句话：**参考 Obsidian 的布局**。
 * 看 Obsidian 就清楚了——它**有**顶栏，而且没人嫌：因为那条栏里装的是真东西
 * （标签页、面包屑、视图动作），窗口按钮长在它右端，整条空白处都能拖窗口。
 * 一条栏让人嫌，从来不是因为它存在，是因为它是空的。
 *
 * 所以这一版：
 * - 中间是**面包屑**（目录 / 文件名），和 Obsidian 的 view header 一样；
 * - 右端是视图动作（阅读/编辑切换）+ 窗口按钮；
 * - **整条都是拖拽区**——这是 v0.11.3 丢掉的东西，也是最该有的：
 *   窗口顶边本来就是所有人下意识去拖的地方。
 */
import { useEffect, useRef, useState } from 'react';
import { RibbonIcon } from './Icons';
import { ContextMenu, type MenuAnchor, type MenuItem } from './ContextMenu';
import { needsCustomChrome } from './WindowChrome';

export interface TopBarProps {
  /** 当前笔记的库内路径；null = 没开笔记 */
  currentPath: string | null;
  /** 阅读 / 编辑，null = 当前不是笔记视图（例如在看 PDF），不显示这个开关 */
  mode?: 'edit' | 'read' | null;
  onToggleMode?(): void;
  /**
   * 侧栏折叠。放在顶栏最左边——Obsidian 就是这个位置，也是所有人第一眼去找的地方。
   * 不给 `onToggleSidebar` 就不渲染（手机端没有这个概念）。
   */
  sidebarOpen?: boolean;
  onToggleSidebar?(): void;
  /**
   * 「⋯」菜单里的当前笔记动作（重命名 / 移动 / 导出 PDF / 删除…）。
   * 空数组 = 不显示这个按钮，绝不摆一个点开是空的菜单。
   */
  noteMenu?: MenuItem[];
  /**
   * v0.11.11：标签页。
   *
   * v0.10.7 删掉的是**单独占一整行、空荡荡的那条标签栏**，不是"标签"本身；
   * 用户这次要的是 Obsidian 的形状——标签就长在顶栏里，顺便把这条本来
   * 有点空的栏填满。所以它占的是原来放面包屑的那块位置，不新增一行。
   *
   * 不传 `tabs` 时退回面包屑（移动端与没有标签的场景）。
   */
  tabs?: string[];
  onSelectTab?(path: string): void;
  onCloseTab?(path: string): void;
  onNewTab?(): void;
}

/** 标签上显示的名字：只留文件名、去扩展名（完整路径在 title 里） */
export function tabLabel(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.(md|markdown)$/i, '');
}

/** `亚马逊/201规划.md` → ['亚马逊', '201规划']；隐藏 .md 后缀 */
export function breadcrumb(path: string | null): string[] {
  if (!path) return [];
  return path.replace(/\.(md|markdown)$/i, '').split('/').filter(Boolean);
}

/**
 * 无边框窗口的缩放热区。
 *
 * 用户反馈：「拖动窗口大小要放在阴影的边缘而不是窗口的边缘」。
 * 自绘边框之后，操作系统的缩放边框落在**窗口最外那一像素**上——而那里离看得见的
 * 卡片边还有 10px 的透明留白，用户瞄的是卡片边（阴影所在的位置），自然拖不到。
 *
 * 所以自己铺 8 个热区：覆盖整圈透明留白，再往卡片里压 2px，让"看得见的边"就是
 * 能拖的边。最大化时窗口不可缩放，直接不渲染（留着只会挡住边缘的点击）。
 */
const EDGES = [
  ['n', 'North'],
  ['s', 'South'],
  ['w', 'West'],
  ['e', 'East'],
  ['nw', 'NorthWest'],
  ['ne', 'NorthEast'],
  ['sw', 'SouthWest'],
  ['se', 'SouthEast'],
] as const;

function ResizeEdges() {
  const start = async (dir: (typeof EDGES)[number][1], ev: React.MouseEvent) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().startResizeDragging(dir);
    } catch {
      /* 拿不到窗口就当没有这条能力，正常点击不受影响 */
    }
  };
  return (
    <>
      {EDGES.map(([cls, dir]) => (
        <div
          key={cls}
          className={`win-resize win-resize-${cls}`}
          onMouseDown={(e) => void start(dir, e)}
        />
      ))}
    </>
  );
}

export function TopBar(props: TopBarProps) {
  const [frameless] = useState(needsCustomChrome);
  const [maximized, setMaximized] = useState(false);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const parts = breadcrumb(props.currentPath);

  useEffect(() => {
    if (!frameless) return;
    let un: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const w = getCurrentWindow();
        const sync = async () => {
          const m = await w.isMaximized();
          if (!cancelled) setMaximized(m);
        };
        await sync();
        // onResized 覆盖最大化/还原/贴边三种情况；单听 maximize 会漏掉 Win+↑
        un = await w.onResized(() => void sync());
      } catch {
        /* 拿不到窗口就保持"未最大化"的样子，按钮仍然可点 */
      }
    })();
    return () => {
      cancelled = true;
      un?.();
    };
  }, [frameless]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.classList.toggle('frameless', frameless);
    root.classList.toggle('win-maximized', frameless && maximized);
    return () => {
      root.classList.remove('frameless', 'win-maximized');
    };
  }, [frameless, maximized]);

  const call = async (fn: 'minimize' | 'toggleMaximize' | 'close') => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow()[fn]();
    } catch {
      /* 忽略：窗口已经在关了 */
    }
  };

  return (
    // 整条都是拖拽区。属性打在容器与各个"空白"子元素上：
    // 按钮是子元素、不带这个属性，点击照常工作
    <header className="top-bar" data-tauri-drag-region>
      {props.onToggleSidebar && (
        <button
          className="tb-btn tb-side"
          title={props.sidebarOpen ? '收起侧边栏（Ctrl+\\）' : '展开侧边栏（Ctrl+\\）'}
          aria-label="切换侧边栏"
          aria-pressed={props.sidebarOpen ?? true}
          onClick={props.onToggleSidebar}
        >
          <RibbonIcon name="sidebar" size={16} />
        </button>
      )}
      {props.tabs && props.tabs.length > 0 ? (
        /* 标签之间的缝隙、以及右侧余白都要能拖窗口：v0.11.3 丢过一次"顶栏不能拖"，
           那次用户的原话是「点哪都拖不动」。标签本身是子元素，不受影响。 */
        <div className="tb-tabs" role="tablist" aria-label="打开的笔记" data-tauri-drag-region>
          {props.tabs.map((path) => (
            <div
              key={path}
              role="tab"
              aria-selected={path === props.currentPath}
              className={`tb-tab ${path === props.currentPath ? 'on' : ''}`}
              title={path}
              onMouseDown={(e) => {
                // 中键关闭：浏览器/编辑器通用手势
                if (e.button === 1) {
                  e.preventDefault();
                  props.onCloseTab?.(path);
                }
              }}
              onClick={() => props.onSelectTab?.(path)}
            >
              <span className="tb-tab-name">{tabLabel(path)}</span>
              <button
                className="tb-tab-x"
                aria-label={`关闭 ${tabLabel(path)}`}
                title="关闭"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onCloseTab?.(path);
                }}
              >
                <RibbonIcon name="close" size={12} />
              </button>
            </div>
          ))}
          {props.onNewTab && (
            <button className="tb-tab-new" title="新建笔记" aria-label="新建笔记" onClick={props.onNewTab}>
              <RibbonIcon name="plus" size={14} />
            </button>
          )}
          <span className="tb-drag" data-tauri-drag-region />
        </div>
      ) : (
        <div className="tb-crumb" data-tauri-drag-region>
          {parts.length === 0 ? (
            <span className="tb-empty" data-tauri-drag-region>
              Ivyea Note
            </span>
          ) : (
            parts.map((p, i) => (
              <span key={i} className={i === parts.length - 1 ? 'tb-name' : 'tb-dir'} data-tauri-drag-region>
                {p}
                {i < parts.length - 1 && <span className="tb-sep">/</span>}
              </span>
            ))
          )}
        </div>
      )}
      <div className="tb-actions">
        {props.mode && props.onToggleMode && (
          <button
            className="tb-btn"
            title={props.mode === 'edit' ? '阅读视图（Ctrl+E）' : '编辑视图（Ctrl+E）'}
            aria-label="切换阅读 / 编辑"
            onClick={props.onToggleMode}
          >
            <RibbonIcon name={props.mode === 'edit' ? 'book' : 'edit'} size={16} />
          </button>
        )}
        {props.noteMenu && props.noteMenu.length > 0 && (
          <button
            ref={moreRef}
            className="tb-btn"
            title="更多操作"
            aria-label="更多操作"
            onClick={() => {
              const r = moreRef.current?.getBoundingClientRect();
              // 贴着按钮左下角展开；ContextMenu 自己会在贴边时往回翻
              setMenu({ x: (r?.right ?? 0) - 8, y: (r?.bottom ?? 0) + 4, items: props.noteMenu! });
            }}
          >
            <RibbonIcon name="more-vertical" size={16} />
          </button>
        )}
        {frameless && (
          <div className="win-buttons">
            <button className="win-btn" title="最小化" aria-label="最小化" onClick={() => void call('minimize')}>
              <RibbonIcon name="win-min" size={16} stroke={1.1} />
            </button>
            <button
              className="win-btn"
              title={maximized ? '向下还原' : '最大化'}
              aria-label={maximized ? '向下还原' : '最大化'}
              onClick={() => void call('toggleMaximize')}
            >
              <RibbonIcon name={maximized ? 'win-restore' : 'win-max'} size={16} stroke={1.1} />
            </button>
            <button className="win-btn danger" title="关闭" aria-label="关闭" onClick={() => void call('close')}>
              <RibbonIcon name="win-close" size={16} stroke={1.1} />
            </button>
          </div>
        )}
      </div>
      {menu && <ContextMenu anchor={menu} onClose={() => setMenu(null)} />}
      {frameless && !maximized && <ResizeEdges />}
    </header>
  );
}

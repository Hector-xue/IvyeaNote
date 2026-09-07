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
import { useEffect, useState } from 'react';
import { RibbonIcon } from './Icons';
import { needsCustomChrome } from './WindowChrome';

export interface TopBarProps {
  /** 当前笔记的库内路径；null = 没开笔记 */
  currentPath: string | null;
  /** 阅读 / 编辑，null = 当前不是笔记视图（例如在看 PDF），不显示这个开关 */
  mode?: 'edit' | 'read' | null;
  onToggleMode?(): void;
}

/** `亚马逊/201规划.md` → ['亚马逊', '201规划']；隐藏 .md 后缀 */
export function breadcrumb(path: string | null): string[] {
  if (!path) return [];
  return path.replace(/\.(md|markdown)$/i, '').split('/').filter(Boolean);
}

export function TopBar(props: TopBarProps) {
  const [frameless] = useState(needsCustomChrome);
  const [maximized, setMaximized] = useState(false);
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
    </header>
  );
}

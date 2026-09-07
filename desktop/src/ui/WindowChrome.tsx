/**
 * 自绘窗口边框（v0.11.0，仅 Windows 桌面端）。
 *
 * # 用户说的是哪一条
 *
 * 「还有我上次让你删除的这个顶部栏」——v0.10.7 删掉的是**标签栏**，而截图里圈的
 * 是 Windows 自己的**标题栏**（左边应用名、右边最小化/最大化/关闭）。它一直都在，
 * 因为 `tauri.conf.json` 从来没设过 `decorations: false`。
 * 「整个窗口还不是 R 角」是同一件事的另一半：我量过截图，(0,0) 是桌面色、(1,1)
 * 已经是白色——这台机器上窗口是直角（Win10 不会自动给窗口倒角）。
 *
 * # 做法与代价
 *
 * `decorations: false` + `transparent: true`（只写在 `tauri.windows.conf.json` 里，
 * Linux/macOS 保持原生边框，不去冒它们各自合成器的风险），圆角由 CSS 画。
 * 代价是系统投影没有了，所以这里补一条极淡的描边——不然窗口在浅色桌面上会没有边界。
 * **最大化时必须收成直角**：圆角留着的话，四个角会露出桌面，非常明显。
 *
 * 非 Windows / 非 Tauri（浏览器、安卓）一律返回 null：那些环境本来就没有我们该画的边框。
 */
import { useEffect, useState } from 'react';
import { RibbonIcon } from './Icons';

/** 这份运行环境需不需要自绘边框 */
export function needsCustomChrome(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if (!('__TAURI_INTERNALS__' in window)) return false;
  // 安卓的 UA 里也有 "Windows"？没有；但保险起见先排除移动端
  if (/Android|iPhone|iPad/i.test(navigator.userAgent)) return false;
  return /Windows/i.test(navigator.userAgent);
}

export function WindowChrome() {
  const [enabled] = useState(needsCustomChrome);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!enabled) return;
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
        // onResized 覆盖了最大化/还原/贴边三种情况；单听 maximize 会漏掉 Win+↑
        un = await w.onResized(() => void sync());
      } catch {
        /* 拿不到窗口就保持"未最大化"的样子，按钮仍然可点 */
      }
    })();
    return () => {
      cancelled = true;
      un?.();
    };
  }, [enabled]);

  // 圆角要跟着最大化状态走，而画圆角的是 #root，所以状态挂在 <html> 上
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.classList.toggle('frameless', enabled);
    root.classList.toggle('win-maximized', enabled && maximized);
    return () => {
      root.classList.remove('frameless', 'win-maximized');
    };
  }, [enabled, maximized]);

  if (!enabled) return null;

  const call = async (fn: 'minimize' | 'toggleMaximize' | 'close') => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow()[fn]();
    } catch {
      /* 忽略：窗口已经在关了 */
    }
  };

  return (
    <div className="win-chrome" data-tauri-drag-region>
      {/* 左半边整条都是拖拽区，什么都不画——用户要的是"顶部栏没了"，
          不是"换一条我们自己的标题栏"。窗口名在任务栏上已经有了 */}
      <div className="win-drag" data-tauri-drag-region />
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
        <button
          className="win-btn danger"
          title="关闭"
          aria-label="关闭"
          onClick={() => void call('close')}
        >
          <RibbonIcon name="win-close" size={16} stroke={1.1} />
        </button>
      </div>
    </div>
  );
}

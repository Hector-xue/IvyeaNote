/**
 * 面板拖拽调宽 + 宽度持久化（方案 §4.4，v0.8.1）。
 *
 * 侧栏和右栏此前是写死的 264 / 248px。笔记标题一长就被截断，而右栏的大纲又空着
 * 半屏——「宽度归用户」是文件树类界面的基本盘（Obsidian / VSCode / Finder 都给）。
 *
 * 三件事：
 * - 指针拖拽实时改宽（用 Pointer Events + setPointerCapture，鼠标划出窗口也不断线）；
 * - 键盘也能调（把手是 `role="separator"`，左右方向键 ±16px）——纯鼠标交互对
 *   键盘用户就是死路；
 * - 双击复位到默认宽度。
 *
 * 只在松手/键盘操作后写 localStorage，拖拽过程中不写——按住不放拖两秒会写几百次。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface PanelWidthOptions {
  /** localStorage 键 */
  key: string;
  /** 默认宽度，也是双击复位的目标 */
  defaultWidth: number;
  min?: number;
  max?: number;
  /**
   * 把手在面板的哪一侧。`right` = 面板在左（侧栏），把手在它右边，右拖变宽；
   * `left` = 面板在右（右栏），把手在它左边，左拖变宽。
   */
  edge: 'left' | 'right';
}

export interface PanelWidth {
  width: number;
  /** 摊到把手元素上的属性（含无障碍语义） */
  handleProps: {
    role: 'separator';
    tabIndex: 0;
    'aria-orientation': 'vertical';
    'aria-valuenow': number;
    'aria-valuemin': number;
    'aria-valuemax': number;
    'aria-label': string;
    onPointerDown(e: React.PointerEvent<HTMLElement>): void;
    onKeyDown(e: React.KeyboardEvent<HTMLElement>): void;
    onDoubleClick(): void;
  };
  /** 拖拽中：调用方可据此加个高亮类 */
  dragging: boolean;
}

export function clampWidth(w: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(w)));
}

function load(key: string, fallback: number, min: number, max: number): number {
  const raw = localStorage.getItem(key);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? clampWidth(n, min, max) : fallback;
}

export function usePanelWidth(opts: PanelWidthOptions & { label: string }): PanelWidth {
  const { key, defaultWidth, edge, label } = opts;
  const min = opts.min ?? 180;
  const max = opts.max ?? 520;

  const [width, setWidth] = useState(() => load(key, defaultWidth, min, max));
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; startW: number } | null>(null);

  const persist = useCallback(
    (w: number) => {
      localStorage.setItem(key, String(w));
    },
    [key]
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { startX: e.clientX, startW: width };
      setDragging(true);
    },
    [width]
  );

  // 监听挂在 window 上而不是把手上：拖到窗口边缘时指针可能离开元素，
  // 只靠元素自身的 move/up 会出现「松手了还在拖」。
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      setWidth(clampWidth(edge === 'right' ? d.startW + dx : d.startW - dx, min, max));
    };
    const onUp = () => {
      drag.current = null;
      setDragging(false);
      setWidth((w) => {
        persist(w);
        return w;
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [dragging, edge, min, max, persist]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      const step = e.shiftKey ? 64 : 16;
      let next: number | null = null;
      if (e.key === 'ArrowLeft') next = width + (edge === 'right' ? -step : step);
      else if (e.key === 'ArrowRight') next = width + (edge === 'right' ? step : -step);
      else if (e.key === 'Home') next = min;
      else if (e.key === 'End') next = max;
      else if (e.key === 'Enter') next = defaultWidth;
      if (next === null) return;
      e.preventDefault();
      const w = clampWidth(next, min, max);
      setWidth(w);
      persist(w);
    },
    [width, edge, min, max, defaultWidth, persist]
  );

  const onDoubleClick = useCallback(() => {
    setWidth(defaultWidth);
    persist(defaultWidth);
  }, [defaultWidth, persist]);

  return {
    width,
    dragging,
    handleProps: {
      role: 'separator',
      tabIndex: 0,
      'aria-orientation': 'vertical',
      'aria-valuenow': width,
      'aria-valuemin': min,
      'aria-valuemax': max,
      'aria-label': `${label}宽度（方向键调整，双击复位）`,
      onPointerDown,
      onKeyDown,
      onDoubleClick,
    },
  };
}

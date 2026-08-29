/**
 * 上下文菜单（v0.7.9 E3）。
 *
 * 桌面右键 / 移动长按用**同一个**菜单定义，避免两端各写一份、功能长歪——
 * v0.7.4 的现状就是：重命名只有移动端长按有，桌面端根本没入口。
 *
 * 三个必须处理的细节，少一个就会露怯：
 * - 贴边翻转：菜单在屏幕右/下边缘时要往回翻，否则一半在视口外；
 * - 点外面关、Esc 关、滚动关；
 * - 打开时把焦点收进菜单，键盘上下键可走——右键菜单不该是鼠标专属。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface MenuItem {
  id: string;
  label: string;
  danger?: boolean;
  run(): void;
}

export interface MenuAnchor {
  x: number;
  y: number;
  items: MenuItem[];
}

interface Props {
  anchor: MenuAnchor | null;
  onClose(): void;
}

export function ContextMenu({ anchor, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [active, setActive] = useState(0);

  // 先渲染到锚点，量到真实尺寸后再决定要不要贴边翻转
  useLayoutEffect(() => {
    if (!anchor) {
      setPos(null);
      return;
    }
    setActive(0);
    const el = ref.current;
    const w = el?.offsetWidth ?? 180;
    const h = el?.offsetHeight ?? 200;
    const pad = 8;
    setPos({
      left: Math.min(anchor.x, window.innerWidth - w - pad),
      top: Math.min(anchor.y, window.innerHeight - h - pad),
    });
  }, [anchor]);

  useEffect(() => {
    if (!anchor) return;
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => (i + 1) % anchor.items.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i - 1 + anchor.items.length) % anchor.items.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const item = anchor.items[active];
        onClose();
        item?.run();
      }
    };
    window.addEventListener('keydown', onKey);
    // capture 阶段监听：菜单项自己的 onClick 先跑完，不会被这里抢先关掉
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [anchor, active, onClose]);

  if (!anchor) return null;

  return (
    <div className="ctx-mask" onMouseDown={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div
        ref={ref}
        className="ctx-menu"
        role="menu"
        style={pos ? { left: pos.left, top: pos.top } : { left: anchor.x, top: anchor.y, visibility: 'hidden' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {anchor.items.map((it, i) => (
          <button
            key={it.id}
            role="menuitem"
            className={`ctx-item ${it.danger ? 'danger' : ''} ${i === active ? 'active' : ''}`}
            onMouseEnter={() => setActive(i)}
            onClick={() => {
              onClose();
              it.run();
            }}
          >
            {it.label}
          </button>
        ))}
      </div>
    </div>
  );
}

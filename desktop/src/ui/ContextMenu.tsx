/**
 * 上下文菜单（v0.7.9 E3 起；v0.11.0 重做）。
 *
 * 桌面右键 / 移动长按用**同一个**菜单定义，避免两端各写一份、功能长歪。
 *
 * v0.11.0 之前这里只能画一层扁平的纯文字列表——于是编辑区的右键菜单
 * 「本来就做不出来」：Obsidian 那张菜单里有图标、有分隔线、有「文本格式 ▸」
 * 「段落设置 ▸」「插入 ▸」三个二级菜单，还有剪切/复制在没有选区时置灰。
 * 现在这四件事都是这个组件的一等能力：
 * - `icon`：每项左侧一个线性图标（和 ribbon 同一套字形）；
 * - `{ type: 'sep' }`：分隔线；
 * - `submenu`：二级菜单，hover 150ms 或 → 键展开，← 键收回；
 * - `disabled` / `checked` / `shortcut`：置灰、打勾、右侧快捷键提示。
 *
 * 三个必须处理的细节，少一个就会露怯：
 * - 贴边翻转：菜单在屏幕右/下边缘时要往回翻，否则一半在视口外；
 * - 点外面关、Esc 关、滚动关；
 * - 打开时键盘可走——右键菜单不该是鼠标专属（分隔线与禁用项要跳过）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { RibbonIcon, type IconName } from './Icons';

export interface MenuAction {
  id: string;
  label: string;
  /** 左侧图标。不给就留空位对齐——一列里有的有图标有的没有会歪 */
  icon?: IconName;
  danger?: boolean;
  /** 置灰：条目仍然显示（用户能看见"这里本来有这个功能"），只是点不动 */
  disabled?: boolean;
  /** 打勾（排序方式这类单选项） */
  checked?: boolean;
  /** 右侧快捷键提示，如 `Ctrl+B` */
  shortcut?: string;
  /**
   * 右侧一句灰字，说明这一项会做什么。
   * 给 AI 那组用：「校对」「润色」「精简」光看名字分不清差别，
   * 而这些动作会直接改用户的正文——点之前就得知道它要干嘛。
   */
  hint?: string;
  /** 二级菜单。有 submenu 就不该再有 run */
  submenu?: MenuItem[];
  run?(): void;
}

export interface MenuSeparator {
  type: 'sep';
  id: string;
}

export type MenuItem = MenuAction | MenuSeparator;

export function isSeparator(it: MenuItem): it is MenuSeparator {
  return (it as MenuSeparator).type === 'sep';
}

/** 可被键盘选中的项：跳过分隔线与置灰项 */
function selectable(items: MenuItem[]): number[] {
  const out: number[] = [];
  items.forEach((it, i) => {
    if (!isSeparator(it) && !it.disabled) out.push(i);
  });
  return out;
}

export interface MenuAnchor {
  x: number;
  y: number;
  items: MenuItem[];
  /**
   * v0.11.26：下方放不下时**翻到这条线之上**（传按钮的 top）。
   * 状态栏那颗「AI」在屏幕最底下，此前放不下只是把菜单往上挪到刚好贴底——
   * 结果整张菜单压在状态栏上，「整理排版」盖住了「插入图片」那一行（用户截图）。
   */
  flipY?: number;
}

interface PanelProps {
  items: MenuItem[];
  /** 期望的左上角位置（会按视口贴边翻转） */
  x: number;
  y: number;
  /** 二级菜单往左翻时，要贴回父菜单的左边缘 */
  flipFromX?: number;
  /** 下方放不下时翻到这条线之上（见 MenuAnchor.flipY） */
  flipY?: number;
  /** 这一层是不是当前接管键盘的那一层 */
  focused: boolean;
  onCloseAll(): void;
  /** 子菜单请求把键盘还给父级（按了 ←） */
  onBack?(): void;
  depth: number;
}

function MenuPanel({ items, x, y, flipFromX, flipY, focused, onCloseAll, onBack, depth }: PanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [active, setActive] = useState<number>(() => selectable(items)[0] ?? -1);
  /** 展开中的二级菜单：索引 + 它该出现的位置 */
  const [sub, setSub] = useState<{ index: number; x: number; y: number; fromX: number } | null>(null);
  const hoverTimer = useRef<number | null>(null);

  // 先渲染到锚点，量到真实尺寸后再决定要不要贴边翻转
  useLayoutEffect(() => {
    const el = ref.current;
    const w = el?.offsetWidth ?? 200;
    const h = el?.offsetHeight ?? 220;
    const pad = 8;
    let left = x;
    // 二级菜单贴右边缘时翻到父菜单左侧，而不是简单地往回挪（那样会盖住父菜单）
    if (left + w > window.innerWidth - pad) {
      left = flipFromX !== undefined ? Math.max(pad, flipFromX - w) : Math.max(pad, window.innerWidth - w - pad);
    }
    let top = Math.max(pad, Math.min(y, window.innerHeight - h - pad));
    // 下方放不下且给了翻转线：整张菜单挪到那条线之上，别压着发起它的那颗按钮
    if (flipY !== undefined && y + h > window.innerHeight - pad) top = Math.max(pad, flipY - h);
    setPos({ left, top });
  }, [x, y, flipFromX, flipY, items]);

  useEffect(() => {
    return () => {
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    };
  }, []);

  // useCallback：键盘那个 effect 依赖它，内联函数每渲染一次都会让监听重挂
  const openSub = useCallback(
    (index: number, el: HTMLElement) => {
      const it = items[index];
      if (isSeparator(it) || !it.submenu) return;
      const r = el.getBoundingClientRect();
      const panel = ref.current?.getBoundingClientRect();
      setSub({ index, x: r.right - 4, y: r.top - 6, fromX: panel?.left ?? r.left });
    },
    [items]
  );

  /*
   * 键盘归属：展开了子菜单，这一层就把方向键交出去——否则父子两层同时挂着
   * window 监听，按一下 ↓ 两层的高亮一起动。
   */
  const ownsKeyboard = focused && sub === null;

  useEffect(() => {
    if (!ownsKeyboard) return;
    const onKey = (e: KeyboardEvent) => {
      const sel = selectable(items);
      if (sel.length === 0) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (onBack) onBack();
        else onCloseAll();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const at = sel.indexOf(active);
        const next = e.key === 'ArrowDown' ? (at + 1) % sel.length : (at - 1 + sel.length) % sel.length;
        setActive(sel[at === -1 ? 0 : next]);
      } else if (e.key === 'ArrowRight') {
        const it = items[active];
        if (!isSeparator(it) && it?.submenu) {
          e.preventDefault();
          const el = ref.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
          if (el) openSub(active, el);
        }
      } else if (e.key === 'ArrowLeft') {
        if (onBack) {
          e.preventDefault();
          onBack();
        }
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const it = items[active];
        if (isSeparator(it) || !it) return;
        if (it.submenu) {
          const el = ref.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
          if (el) openSub(active, el);
          return;
        }
        onCloseAll();
        it.run?.();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ownsKeyboard, items, active, onBack, onCloseAll, openSub]);

  const subItem = sub !== null ? items[sub.index] : null;

  return (
    <>
      <div
        ref={ref}
        className={`ctx-menu ${depth > 0 ? 'ctx-sub-menu' : ''}`}
        role="menu"
        style={pos ? { left: pos.left, top: pos.top } : { left: x, top: y, visibility: 'hidden' }}
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((it, i) =>
          isSeparator(it) ? (
            <div key={it.id} className="ctx-sep" role="separator" />
          ) : (
            <button
              key={it.id}
              data-idx={i}
              role="menuitem"
              type="button"
              disabled={it.disabled}
              aria-haspopup={it.submenu ? 'menu' : undefined}
              aria-expanded={it.submenu ? sub?.index === i : undefined}
              className={`ctx-item ${it.danger ? 'danger' : ''} ${i === active ? 'active' : ''} ${
                it.disabled ? 'disabled' : ''
              }`}
              onMouseEnter={(e) => {
                if (it.disabled) return;
                setActive(i);
                const el = e.currentTarget;
                if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
                if (it.submenu) {
                  hoverTimer.current = window.setTimeout(() => openSub(i, el), 130);
                } else if (sub !== null) {
                  // 移到没有子菜单的条目上要把已展开的那个收掉，否则两张菜单一起挂着
                  hoverTimer.current = window.setTimeout(() => setSub(null), 200);
                }
              }}
              onClick={(e) => {
                if (it.disabled) return;
                if (it.submenu) {
                  openSub(i, e.currentTarget);
                  return;
                }
                onCloseAll();
                it.run?.();
              }}
            >
              <span className="ctx-icon">
                {it.checked ? (
                  <RibbonIcon name="check" size={14} />
                ) : it.icon ? (
                  <RibbonIcon name={it.icon} size={14} />
                ) : null}
              </span>
              <span className="ctx-label">{it.label}</span>
              {it.hint && <span className="ctx-hint">{it.hint}</span>}
              {it.shortcut && <span className="ctx-shortcut">{it.shortcut}</span>}
              {it.submenu && (
                <span className="ctx-arrow">
                  <RibbonIcon name="chevron-right" size={13} />
                </span>
              )}
            </button>
          )
        )}
      </div>
      {sub && subItem && !isSeparator(subItem) && subItem.submenu && (
        <MenuPanel
          items={subItem.submenu}
          x={sub.x}
          y={sub.y}
          flipFromX={sub.fromX}
          focused={focused}
          depth={depth + 1}
          onCloseAll={onCloseAll}
          onBack={() => setSub(null)}
        />
      )}
    </>
  );
}

interface Props {
  anchor: MenuAnchor | null;
  onClose(): void;
}

export function ContextMenu({ anchor, onClose }: Props) {
  useEffect(() => {
    if (!anchor) return;
    const close = () => onClose();
    // capture 阶段监听：菜单项自己的 onClick 先跑完，不会被这里抢先关掉
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [anchor, onClose]);

  if (!anchor) return null;

  return (
    <div className="ctx-mask" onMouseDown={onClose} onContextMenu={(e) => e.preventDefault()}>
      <MenuPanel
        // anchor 换了就要整棵重建（否则上一次展开的子菜单会跟着新菜单一起出现）
        key={`${anchor.x},${anchor.y},${anchor.items.length}`}
        items={anchor.items}
        x={anchor.x}
        y={anchor.y}
        flipY={anchor.flipY}
        focused
        depth={0}
        onCloseAll={onClose}
      />
    </div>
  );
}

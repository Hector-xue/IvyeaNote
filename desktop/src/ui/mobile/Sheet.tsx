/**
 * 移动端底部弹出菜单（v0.10.0）。
 *
 * 照 Obsidian 移动端那套：从底部推上来的一张卡，顶上一条拖拽把手，
 * 内容按**语义分组**成若干张圆角小卡，每项左边一个线性图标。
 *
 * 之前我们用的是一个没有分组、没有图标、只有三行文字的 `.m-sheet`——
 * 同样是「底部菜单」，观感上完全不是一回事。分组和图标不是装饰：
 * 十几个动作平铺成一列时，人根本扫不出哪些是一类。
 */
import { useEffect, useRef } from 'react';
import { RibbonIcon, type IconName } from '../Icons';

export interface SheetItem {
  key: string;
  icon: IconName;
  label: string;
  /** 右侧的状态标记，比如当前处于哪个视图 */
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick(): void;
}

interface Props {
  open: boolean;
  /** 卡片顶部的标题（可省；Obsidian 多数菜单没有标题） */
  title?: string;
  /** 每个数组是一张小卡 */
  groups: SheetItem[][];
  onClose(): void;
}

export function Sheet({ open, title, groups, onClose }: Props) {
  /*
   * v0.10.2：**刚弹出来的一瞬间不接受遮罩点击**。
   *
   * 长按呼出这张卡时，手指抬起后浏览器还会补一次 click，坐标就是刚才按住的位置——
   * 那里此刻已经被遮罩盖住，于是「长按 → 卡片弹出 → 立刻自己关掉」，
   * 看起来就是长按压根没反应。350ms 足够甩掉那次合成点击，又短到用户
   * 感觉不出来（真想关就再点一下）。
   */
  const openedAt = useRef(0);
  useEffect(() => {
    if (open) openedAt.current = Date.now();
  }, [open]);

  if (!open) return null;
  const shown = groups.filter((g) => g.length > 0);
  const maskClick = () => {
    if (Date.now() - openedAt.current < 350) return;
    onClose();
  };
  return (
    <div className="m-sheet-mask" onClick={maskClick}>
      <div
        className="m-sheet2"
        role="dialog"
        aria-modal="true"
        aria-label={title ?? '菜单'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="m-sheet2-grip" aria-hidden="true" />
        {title && <div className="m-sheet2-title">{title}</div>}
        <div className="m-sheet2-scroll">
          {shown.map((group, gi) => (
            <div className="m-sheet2-group" key={gi}>
              {group.map((it) => (
                <button
                  key={it.key}
                  className={`m-sheet2-item ${it.danger ? 'danger' : ''}`}
                  disabled={it.disabled}
                  onClick={() => {
                    onClose();
                    it.onClick();
                  }}
                >
                  <span className="m-sheet2-ico">
                    <RibbonIcon name={it.icon} size={20} />
                  </span>
                  <span className="m-sheet2-label">{it.label}</span>
                  {it.checked && (
                    <span className="m-sheet2-check">
                      <RibbonIcon name="check" size={18} />
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

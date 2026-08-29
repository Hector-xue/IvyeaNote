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
  if (!open) return null;
  const shown = groups.filter((g) => g.length > 0);
  return (
    <div className="m-sheet-mask" onClick={onClose}>
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

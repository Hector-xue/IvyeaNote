/**
 * 移动端底部弹出菜单（v0.10.0；v0.11.18 换壳 + 去线）。
 *
 * 照 Obsidian 移动端那套：从底部推上来的一张纸，顶上一条把手，内容按**语义分组**，
 * 每项左边一个线性图标。分组和图标不是装饰：十几个动作平铺成一列时，
 * 人根本扫不出哪些是一类。
 *
 * v0.11.18：**分组改用留白，一根线都不画**（用户：「这么多横线还长短不一，好难看」），
 * 外壳与下滑关闭手势搬进 ui/mobile/BottomSheet——四处弹层共用同一份形状与手势。
 */
import { RibbonIcon, type IconName } from '../Icons';
import { BottomSheet } from './BottomSheet';

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
  const shown = groups.filter((g) => g.length > 0);
  return (
    <BottomSheet open={open} title={title} label={title ?? '菜单'} onClose={onClose}>
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
    </BottomSheet>
  );
}

/**
 * v0.5.0 U2：多标签页（对标 Obsidian 顶部标签栏）。
 * - 打开笔记即开标签；点击切换；× 关闭；当前标签高亮
 * - 标签列表由 App 管理（openTabs: 路径数组 + activeTab），本组件纯展示
 */
import { RibbonIcon } from './Icons';

export interface TabsBarProps {
  tabs: string[];
  active: string | null;
  onSelect(path: string): void;
  onClose(path: string): void;
  /** 右端插槽：窗格动作（分栏等） */
  right?: React.ReactNode;
}

/** 标签显示名：取 basename 并隐藏 md 后缀 */
export function tabLabel(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.(md|markdown)$/i, '');
}

export function TabsBar(props: TabsBarProps) {
  if (props.tabs.length === 0) return null;
  return (
    <div className="tabs-bar" role="tablist">
      {props.tabs.map((t) => (
        <div
          key={t}
          role="tab"
          aria-selected={props.active === t}
          className={`tab ${props.active === t ? 'active' : ''}`}
          title={t}
          onClick={() => props.onSelect(t)}
        >
          <span className="tab-label">{tabLabel(t)}</span>
          <button
            className="tab-close"
            title="关闭标签"
            aria-label={`关闭 ${tabLabel(t)}`}
            onClick={(e) => {
              e.stopPropagation();
              props.onClose(t);
            }}
          >
            <RibbonIcon name="close" size={13} />
          </button>
        </div>
      ))}
      {/* 右端留给窗格动作（分栏）——Obsidian 也是把它放在标签栏这一行 */}
      {props.right && <span className="tabs-right">{props.right}</span>}
    </div>
  );
}

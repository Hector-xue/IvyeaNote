/**
 * 移动端顶栏（v0.10.0）。
 *
 * 照 Obsidian：左边是侧栏开关（不是 ☰ 汉堡），中间是**面包屑路径**而不是光秃秃
 * 一个文件名，右边是阅读/编辑切换与「更多」。
 *
 * 为什么面包屑重要：手机屏幕上没有侧栏常驻，唯一能告诉你「这篇在哪个目录」的
 * 就是这里。之前只显示文件名，笔记一多就彻底失去方位感。
 */
import { RibbonIcon } from '../Icons';

interface Props {
  /** 当前笔记的库内相对路径；null = 没打开笔记 */
  path: string | null;
  vaultName: string;
  mode: 'edit' | 'read';
  syncing: boolean;
  onOpenDrawer(): void;
  onToggleMode(): void;
  onMore(): void;
}

export function TopBar(props: Props) {
  const segs = props.path ? props.path.split('/') : [];
  const name = segs.length ? segs[segs.length - 1].replace(/\.(md|markdown)$/i, '') : null;
  // 目录层级只留最后一层：手机宽度放不下完整路径，而离得最近的那层信息量最大
  const dir = segs.length > 1 ? segs[segs.length - 2] : null;

  return (
    <header className="m-top">
      <button className="m-top-btn" onClick={props.onOpenDrawer} aria-label="打开文件列表">
        <RibbonIcon name="sidebar" size={20} />
      </button>

      <div className="m-crumb" title={props.path ?? props.vaultName}>
        {name ? (
          <>
            {dir && (
              <>
                <span className="m-crumb-dir">{dir}</span>
                <span className="m-crumb-sep">/</span>
              </>
            )}
            <span className="m-crumb-name">{name}</span>
          </>
        ) : (
          <span className="m-crumb-name">{props.vaultName}</span>
        )}
        {props.syncing && <span className="m-crumb-sync" aria-label="同步中" />}
      </div>

      {props.path && (
        <button
          className={`m-top-btn ${props.mode === 'read' ? 'on' : ''}`}
          onClick={props.onToggleMode}
          aria-label={props.mode === 'edit' ? '切换到阅读视图' : '切换到编辑视图'}
        >
          <RibbonIcon name={props.mode === 'edit' ? 'book' : 'edit'} size={20} />
        </button>
      )}
      <button className="m-top-btn" onClick={props.onMore} aria-label="更多">
        <RibbonIcon name="more-vertical" size={20} />
      </button>
    </header>
  );
}

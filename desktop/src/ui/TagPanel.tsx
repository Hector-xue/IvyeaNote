/**
 * 标签面板（v0.8.3 从 App.tsx 的内联 JSX 抽出）。
 *
 * 抽出来的原因不是行数：这块原本整段写在**桌面分支之后**，手机上根本不渲染，
 * 所以「移动端补齐标签入口」不是加个按钮就完事——按钮会是个死按钮。
 * 组件化之后两边共用同一份，点击标签之后要干什么由各端自己决定
 * （桌面走命令面板搜索，手机走抽屉里的全文搜索）。
 */
import { buildTagIndex } from '../lib/tags';
import type { SearchDoc } from '../lib/searchIndex';

interface Props {
  docs: readonly SearchDoc[];
  /** 点了某个标签：调用方决定怎么搜（各端入口不同） */
  onPick(tag: string): void;
  onClose(): void;
}

export function TagPanel({ docs, onPick, onClose }: Props) {
  const idx = buildTagIndex(docs as SearchDoc[]);
  return (
    <div className="dlg-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dlg-card trash-card" role="dialog" aria-modal="true" aria-label="标签">
        <h2 className="dlg-title">标签</h2>
        {idx.size === 0 ? (
          <p className="dlg-desc">还没有标签。在笔记里写 #标签 即可。</p>
        ) : (
          <div className="tag-cloud">
            {[...idx.entries()]
              .sort((a, b) => b[1].length - a[1].length)
              .map(([tag, paths]) => (
                <button key={tag} className="tag-chip" onClick={() => onPick(tag)}>
                  #{tag} <span className="tag-count">{paths.length}</span>
                </button>
              ))}
          </div>
        )}
        <div className="dlg-actions">
          <button className="btn primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

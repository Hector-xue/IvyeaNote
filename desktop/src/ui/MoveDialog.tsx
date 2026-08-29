/**
 * 「移动到…」目录选择器（v0.8.3）。
 *
 * 补两个缺口：
 * - 桌面右键菜单（E3）本来就点名要「移动到」，此前只有拖拽一条路；
 * - 移动端根本没有移动手段（长按只有重命名 / 删除）。
 *
 * 方案 §4.6 写的是「长按拖拽移动」。这里先给选择器而不是触控拖拽，理由是**小屏上
 * 拖到某个目标文件夹本身就很难**（目标只有一行高，还要同时滚动列表），而选择器
 * 在两端都稳。触控拖拽作为锦上添花可以后补，但它不该是移动端唯一的移动方式。
 */
interface Props {
  /** 要移动的东西 */
  srcPath: string;
  isDir: boolean;
  /** 库内全部目录（不含库根） */
  dirs: readonly string[];
  onPick(destDir: string): void;
  onClose(): void;
}

/** 当前所在目录——移到自己已经在的地方是空操作，直接标出来并禁用 */
function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function MoveDialog({ srcPath, isDir, dirs, onPick, onClose }: Props) {
  const here = parentOf(srcPath);
  const name = srcPath.split('/').pop() ?? srcPath;
  const options = ['', ...dirs].filter(
    // 不能把一个文件夹移进它自己或它的子孙里——那会把整棵子树搬没
    (d) => !(isDir && (d === srcPath || d.startsWith(`${srcPath}/`)))
  );

  return (
    <div className="dlg-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dlg-card move-card" role="dialog" aria-modal="true" aria-label="移动到">
        <h2 className="dlg-title">移动「{name}」到…</h2>
        <div className="move-list">
          {options.map((d) => {
            const isHere = d === here;
            return (
              <button
                key={d || '/'}
                className={`move-item ${isHere ? 'here' : ''}`}
                disabled={isHere}
                onClick={() => onPick(d)}
              >
                <span className="move-item-name">{d === '' ? '📁 库根目录' : `📁 ${d}`}</span>
                {isHere && <span className="move-item-tag">当前位置</span>}
              </button>
            );
          })}
          {options.length <= 1 && (
            <p className="dlg-desc">还没有别的文件夹。先用「新建文件夹」建一个。</p>
          )}
        </div>
        <div className="dlg-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

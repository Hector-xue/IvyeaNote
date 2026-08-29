/**
 * 同步状态面板（方案 §5 P4.3，v0.9.2）。
 *
 * 「每文件状态实时可见」。做它的直接理由是刚踩过的一串静默失败——
 * 其中「同步成功、↑0、笔记永远上不去」藏了七个版本；只要有一个地方按
 * **本地内容和最后一次同步成功的内容对不对得上** 去判，第一天就该发现。
 *
 * 所以这个面板刻意**不看同步报告**：报告是「上一次同步自己说干了什么」，
 * 而这里问的是「现在到底还有什么没上去」。两者不一致时，以这里为准。
 */
import { STATE_LABEL, type FileSyncStatus, type SyncSummary } from '../lib/syncStatus';

interface Props {
  loading: boolean;
  list: FileSyncStatus[];
  summary: SyncSummary;
  /** 上一次同步报告里的错误，原样列出——它们此前只在角落里一闪而过 */
  errors: string[];
  onRefresh(): void;
  onSyncNow(): void;
  syncing: boolean;
  onOpen(path: string): void;
  onClose(): void;
}

const ORDER: Record<FileSyncStatus['state'], number> = {
  conflict: 0,
  new: 1,
  modified: 2,
  deleted: 3,
  synced: 4,
};

export function SyncStatusPanel(props: Props) {
  // 要处理的排前面：已同步的放最后，它们不需要人操心
  const list = [...props.list].sort(
    (a, b) => ORDER[a.state] - ORDER[b.state] || a.path.localeCompare(b.path, 'zh-Hans-CN')
  );
  const s = props.summary;

  return (
    <div className="dlg-mask" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="dlg-card sync-card" role="dialog" aria-modal="true" aria-label="同步状态">
        <div className="set-head">
          <h2 className="set-title">同步状态</h2>
          <button className="icon-btn" title="关闭" onClick={props.onClose}>
            ✕
          </button>
        </div>

        <div className="sync-summary">
          <span className={s.pending > 0 ? 'pill warn' : 'pill'}>待推送 {s.pending}</span>
          {s.conflict > 0 && <span className="pill danger">冲突 {s.conflict}</span>}
          <span className="pill">已同步 {s.synced}</span>
          <span className="sync-actions">
            <button className="btn" disabled={props.loading} onClick={props.onRefresh}>
              {props.loading ? '统计中…' : '重新统计'}
            </button>
            <button className="btn primary" disabled={props.syncing} onClick={props.onSyncNow}>
              {props.syncing ? '同步中…' : '立即同步'}
            </button>
          </span>
        </div>

        {props.errors.length > 0 && (
          <ul className="sync-errors">
            {props.errors.map((e, i) => (
              <li key={i}>⚠ {e}</li>
            ))}
          </ul>
        )}

        <div className="sync-list">
          {props.loading && list.length === 0 && <p className="dlg-desc">正在统计…</p>}
          {!props.loading && list.length === 0 && <p className="dlg-desc">这个库里还没有笔记。</p>}
          {list.map((f) => (
            <button key={f.path} className={`sync-row ${f.state}`} onClick={() => props.onOpen(f.path)}>
              <span className="sync-row-path">{f.path}</span>
              <span className="sync-row-state">{STATE_LABEL[f.state]}</span>
              <span className="sync-row-ver">{f.version === undefined ? '' : `v${f.version}`}</span>
            </button>
          ))}
        </div>

        <p className="set-hint">
          状态按「本地内容 vs 最后一次同步成功的内容」现算，不看同步报告——
          报告说的是上次干了什么，这里说的是现在还差什么。
        </p>
      </div>
    </div>
  );
}

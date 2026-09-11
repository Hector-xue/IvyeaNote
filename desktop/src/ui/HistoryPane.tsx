/**
 * 「历史」面板（v0.11.24）：一篇笔记的本机快照 + 云端版本，一条时间线。
 *
 * 用户原话：「被误修改的可真就无法找回了」。这个面板就是那条找回的路：
 * 选一版 → 看它和现在差在哪 → 恢复。恢复是一次普通写盘（先给现在这版留快照），
 * 所以恢复错了还能再恢复回来，没有任何一步是不可逆的。
 *
 * 形状照右栏其它标签：列表行用 `.sp-row` 那套（图标 + 两行文字 + 右侧信息），
 * 对照用 AI 面板那套行底色（`.ai-row add/del`）——同一件事（"改了哪儿"）在
 * 这个产品里只该有一种长相。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RibbonIcon } from './Icons';
import { diffLines } from '../lib/textDiff';
import { fmtFull, fmtSize, fmtWhen } from '../lib/when';
import type { FileHistory, HistoryEntry } from '../hooks/useFileHistory';

export interface HistoryPaneProps {
  path: string | null;
  /** 编辑器里现在的内容（对照与"恢复前先留快照"都要它） */
  current: string;
  history: FileHistory;
  onRestore(path: string, content: string): Promise<void>;
  /** 手机端没有右栏，这个面板嵌在一张纸里；给它一个关闭入口 */
  onClose?(): void;
  toast?(msg: string, kind?: 'info' | 'ok' | 'error'): void;
}

function sourceOf(e: HistoryEntry): string {
  if (e.kind === 'local') return '本机快照';
  if (e.deleted) return `云端 v${e.version} · 删除`;
  return `云端 v${e.version} · ${e.mine ? '这台设备' : '另一台设备'}`;
}

export function HistoryPane(props: HistoryPaneProps) {
  const { path, history, current } = props;
  const [list, setList] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<HistoryEntry | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [view, setView] = useState<'diff' | 'full'>('diff');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (!path) {
      setList([]);
      return;
    }
    setLoading(true);
    try {
      const r = await history.entries(path);
      setList(r.entries);
      setError(r.error);
    } finally {
      setLoading(false);
    }
  }, [path, history]);

  // 换了一篇就重拉，并把上一篇选中的那版丢掉——不能拿 a.md 的旧版恢复到 b.md 上
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPicked(null);
    setContent(null);
    void reload();
  }, [reload]);

  const pick = useCallback(
    async (e: HistoryEntry) => {
      setPicked(e);
      setContent(null);
      if (e.deleted) return;
      try {
        setContent(await e.load());
      } catch (err) {
        props.toast?.(`读取这一版失败：${err instanceof Error ? err.message : String(err)}`, 'error');
        setPicked(null);
      }
    },
    [props]
  );

  const rows = useMemo(
    () => (picked && content !== null && view === 'diff' ? diffLines(current, content) : []),
    [picked, content, view, current]
  );
  const identical = picked !== null && content !== null && content === current;

  const restore = async () => {
    if (!path || !picked || content === null) return;
    setBusy(true);
    try {
      await props.onRestore(path, content);
      props.toast?.(`已恢复到 ${fmtWhen(picked.at)} 的版本（Ctrl+Z 或再选一版可以改回来）`, 'ok');
      setPicked(null);
      setContent(null);
      void reload();
    } catch (err) {
      props.toast?.(`恢复失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!path) return <p className="rp-empty">打开一篇笔记，这里会列出它的历史版本。</p>;

  return (
    <div className="hp">
      <div className="hp-head">
        <span className="hp-title">{list.length > 0 ? `${list.length} 个版本` : loading ? '读取中…' : '没有历史'}</span>
        <button className="sp-link" onClick={() => void reload()} disabled={loading} title="重新读取">
          刷新
        </button>
        {props.onClose && (
          <button className="icon-btn" title="关闭" aria-label="关闭" onClick={props.onClose}>
            <RibbonIcon name="close" size={14} />
          </button>
        )}
      </div>
      {error && <p className="hp-err">云端版本读不到：{error}（本机快照照常可用）</p>}
      {!history.cloud && (
        <p className="hp-hint">本地模式只有本机快照；登录同步后，每台设备推上去的每一版都会在这里。</p>
      )}
      {list.length === 0 && !loading ? (
        <p className="rp-empty">
          还没有历史。每次改动落盘前会自动留一张快照（同一篇 5 分钟一张，保留 30 天）。
        </p>
      ) : (
        <div className="sp-list hp-list" role="listbox" aria-label="历史版本">
          {list.map((e) => (
            <button
              key={e.id}
              role="option"
              aria-selected={picked?.id === e.id}
              className={`sp-row ${picked?.id === e.id ? 'on' : ''} ${e.deleted ? 'hp-deleted' : ''}`}
              title={`${fmtFull(e.at)}${e.size !== undefined ? ` · ${fmtSize(e.size)}` : ''}`}
              onClick={() => void pick(e)}
            >
              <span className="sp-ico">
                <RibbonIcon name={e.kind === 'local' ? 'history' : e.deleted ? 'trash' : 'cloud'} size={14} />
              </span>
              <span className="sp-text">
                <span className="sp-name">{fmtWhen(e.at)}</span>
                <span className="sp-sub">{sourceOf(e)}</span>
              </span>
              {e.size !== undefined && <span className="sp-count">{fmtSize(e.size)}</span>}
            </button>
          ))}
        </div>
      )}

      {picked && (
        <div className="hp-detail">
          <div className="hp-detail-head">
            <span className="hp-detail-when">{fmtFull(picked.at)}</span>
            <span className="hp-detail-src">{sourceOf(picked)}</span>
          </div>
          {picked.deleted ? (
            <p className="hp-hint">这一步是删除，没有内容。选它上面一版可以看到删除前的样子。</p>
          ) : content === null ? (
            <p className="hp-hint">读取中…</p>
          ) : (
            <>
              <div className="hp-tabs" role="tablist">
                <button
                  role="tab"
                  aria-selected={view === 'diff'}
                  className={`rp-tab ${view === 'diff' ? 'on' : ''}`}
                  onClick={() => setView('diff')}
                >
                  对照
                </button>
                <button
                  role="tab"
                  aria-selected={view === 'full'}
                  className={`rp-tab ${view === 'full' ? 'on' : ''}`}
                  onClick={() => setView('full')}
                >
                  全文
                </button>
                <span className="hp-gap" />
                <span className="hp-legend">恢复后：<i className="add">加回</i> <i className="del">去掉</i></span>
              </div>
              <div className="hp-body">
                {identical ? (
                  <p className="hp-hint">这一版和现在一模一样。</p>
                ) : view === 'full' ? (
                  <pre className="hp-full">{content}</pre>
                ) : (
                  <div className="ai-diff">
                    {rows.map((r, i) => (
                      <div key={i} className={r.kind === 'add' ? 'ai-row add' : r.kind === 'del' ? 'ai-row del' : 'ai-row same'}>
                        <span className="ai-sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}</span>
                        <span className="ai-text">{r.text || ' '}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="hp-foot">
                <button
                  className="btn ghost"
                  onClick={() => {
                    void navigator.clipboard?.writeText(content);
                    props.toast?.('已复制这一版的全文', 'ok');
                  }}
                >
                  复制全文
                </button>
                <span className="hp-gap" />
                <button className="btn primary" onClick={() => void restore()} disabled={busy || identical}>
                  恢复到这一版
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

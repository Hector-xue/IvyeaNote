/**
 * 侧栏搜索（v0.7.11 E7）。
 *
 * 此前搜索只有 Ctrl+K 弹层：看一眼就得关掉，没法「一边看结果一边逐条翻」。
 * 而搜索的真实用法恰恰是后者——找资料时要在几篇之间来回跳。
 * 所以升级成侧栏常驻面板：结果按文件分组、带命中行预览、点了不关闭。
 *
 * 检索走 `lib/searchIndex` 的倒排索引（与命令面板同一套），不另起炉灶。
 */
import { useDeferredValue, useMemo, useState } from 'react';
import { searchNotes, type SearchDoc } from '../lib/searchIndex';

interface Props {
  docs: SearchDoc[];
  currentPath: string | null;
  onOpen(path: string): void;
}

function titleOf(path: string): string {
  return path.split('/').pop()?.replace(/\.(md|markdown)$/i, '') ?? path;
}
function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function SearchPanel(props: Props) {
  const [q, setQ] = useState('');
  // 敲键时先让输入框跟手，检索用滞后值——库大时不会每敲一下都卡一帧
  const deferred = useDeferredValue(q);

  const hits = useMemo(
    () => (deferred.trim() ? searchNotes(props.docs, deferred, 60) : []),
    [props.docs, deferred]
  );

  return (
    <div className="search-panel">
      <div className="sp-input-row">
        <input
          className="sp-input"
          type="search"
          value={q}
          placeholder="搜索全部笔记…"
          autoFocus
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {q.trim() === '' ? (
        <p className="sp-tip">
          支持 <code>"精确短语"</code>、<code>path:目录</code>、<code>tag:标签</code>
        </p>
      ) : hits.length === 0 ? (
        <p className="sp-tip">没有匹配的笔记</p>
      ) : (
        <>
          <p className="sp-count">{hits.length} 篇匹配</p>
          <div className="sp-list">
            {hits.map((h) => (
              <button
                key={h.path}
                className={`sp-hit ${props.currentPath === h.path ? 'active' : ''}`}
                onClick={() => props.onOpen(h.path)}
                title={h.path}
              >
                <span className="sp-title">{titleOf(h.path)}</span>
                {dirOf(h.path) && <span className="sp-dir">{dirOf(h.path)}</span>}
                {h.preview.map((line, i) => (
                  <span key={i} className="sp-line">
                    {line}
                  </span>
                ))}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

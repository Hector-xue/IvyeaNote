/**
 * `.base`（Obsidian Bases）表格视图（v0.11.10）。
 *
 * 用户的原话：「obsidian 的个人空间是这样的，但是我的 ivyeanote 就打不开他的这个」。
 * 之前点 `.base` 只会把文件甩给 Obsidian（没装就只剩"在文件夹中定位"）。
 * 现在本地就能渲染：解析那份 YAML → 按条件筛库里的笔记 → 画成表。
 *
 * 界面上刻意保留两样"说实话"的东西：
 * - 顶部的结果数（对齐 Obsidian 的「47 个结果」），一眼看出筛没筛对；
 * - 底部的「N 条筛选条件本版看不懂」，把被忽略的表达式原样列出来。
 *   静默少筛一条，用户只会看到一张莫名其妙多出几十行的表。
 */
import { Fragment, useMemo, useState } from 'react';
import { parseBase, runBase, type BaseNote } from '../lib/bases';
import { RibbonIcon } from './Icons';

interface Props {
  /** `.base` 文件的库内路径 */
  path: string;
  /** 文件内容（YAML） */
  text: string;
  /** 库里全部笔记（正文用于读 frontmatter / 标签 / 链接） */
  notes: BaseNote[];
  onOpenNote(path: string): void;
  onClose(): void;
  /** 交给 Obsidian 打开（装了才有意义，所以是可选的） */
  onOpenExternal?(): void;
}

function baseName(path: string): string {
  const b = path.slice(path.lastIndexOf('/') + 1);
  return b.replace(/\.base$/i, '');
}

export function BaseView(props: Props) {
  const [viewIdx, setViewIdx] = useState(0);
  /** 点表头临时改排序（不写回 .base 文件——那是 Obsidian 的事） */
  const [sortBy, setSortBy] = useState<{ property: string; desc: boolean } | null>(null);

  const parsed = useMemo(() => {
    try {
      return { spec: parseBase(props.text), error: null as string | null };
    } catch (e) {
      return { spec: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [props.text]);

  const spec = parsed.spec;
  const view = spec?.views[Math.min(viewIdx, spec.views.length - 1)];

  const result = useMemo(() => {
    if (!spec || !view) return null;
    const v = sortBy
      ? { ...view, sort: [{ property: sortBy.property, direction: sortBy.desc ? 'DESC' : 'ASC' }] }
      : view;
    return runBase(spec, v, props.notes);
  }, [spec, view, props.notes, sortBy]);

  const grouped = useMemo(() => {
    if (!result) return [];
    const out: { name: string | null; rows: typeof result.rows }[] = [];
    for (const row of result.rows) {
      const last = out[out.length - 1];
      if (last && last.name === row.group) last.rows.push(row);
      else out.push({ name: row.group, rows: [row] });
    }
    return out;
  }, [result]);

  return (
    <div className="base-view">
      <div className="base-head">
        <div className="base-title">
          <RibbonIcon name="table" />
          <span>{baseName(props.path)}</span>
        </div>
        <div className="base-actions">
          {props.onOpenExternal && (
            <button type="button" className="base-btn" onClick={props.onOpenExternal}>
              用 Obsidian 打开
            </button>
          )}
          <button type="button" className="base-btn" onClick={props.onClose} title="关闭">
            关闭
          </button>
        </div>
      </div>

      {parsed.error && (
        <div className="base-empty">
          <p>这个 .base 文件读不出来。</p>
          <p className="base-muted">{parsed.error}</p>
        </div>
      )}

      {spec && result && view && (
        <>
          <div className="base-bar">
            {spec.views.length > 1 && (
              <div className="base-tabs">
                {spec.views.map((v, i) => (
                  <button
                    key={`${v.name ?? v.type}-${i}`}
                    type="button"
                    className={`base-tab ${i === viewIdx ? 'on' : ''}`}
                    onClick={() => {
                      setViewIdx(i);
                      setSortBy(null);
                    }}
                  >
                    {v.name ?? v.type}
                  </button>
                ))}
              </div>
            )}
            <span className="base-count">{result.rows.length} 个结果</span>
          </div>

          {view.type !== 'table' && (
            <div className="base-note">
              这个视图是 <code>{view.type}</code>，本版只画得出表格，先按表格显示。
            </div>
          )}

          <div className="base-table-wrap">
            <table className="base-table">
              <thead>
                <tr>
                  {result.columns.map((c) => (
                    <th
                      key={c.id}
                      onClick={() =>
                        setSortBy((s) =>
                          s && s.property === c.id ? { property: c.id, desc: !s.desc } : { property: c.id, desc: false }
                        )
                      }
                      title="点击按这一列排序"
                    >
                      {c.label}
                      {sortBy?.property === c.id ? (sortBy.desc ? ' ↓' : ' ↑') : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grouped.map((g) => (
                  <Fragment key={g.name ?? '__all__'}>
                    {g.name !== null && (
                      <tr className="base-group">
                        <td colSpan={result.columns.length}>{g.name}</td>
                      </tr>
                    )}
                    {g.rows.map((row) => (
                      <tr key={row.path}>
                        {result.columns.map((c, ci) => (
                          <td key={c.id}>
                            {ci === 0 ? (
                              <button
                                type="button"
                                className="base-link"
                                onClick={() => props.onOpenNote(row.path)}
                              >
                                {row.cells[c.id] || row.path}
                              </button>
                            ) : (
                              row.cells[c.id]
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
            {result.rows.length === 0 && (
              <div className="base-empty">
                <p>没有笔记满足这些条件。</p>
              </div>
            )}
          </div>

          {(result.skipped.length > 0 || spec.unsupportedKeys.length > 0) && (
            <div className="base-skipped">
              {result.skipped.length > 0 && (
                <p>
                  {result.skipped.length} 条筛选条件本版看不懂，已忽略（表里的行会比 Obsidian 多）：
                  {result.skipped.map((s) => (
                    <code key={s}>{s}</code>
                  ))}
                </p>
              )}
              {spec.unsupportedKeys.length > 0 && (
                <p>
                  暂不支持的段落：
                  {spec.unsupportedKeys.map((k) => (
                    <code key={k}>{k}</code>
                  ))}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

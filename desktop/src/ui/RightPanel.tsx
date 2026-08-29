/**
 * 桌面右栏：大纲 + 双链（v0.7.9 E8）。
 *
 * 移动端早就有大纲浮层和反链区块，桌面反而没有——反链只在编辑区底部挤成一条横排，
 * 大纲干脆没有。写长文时这两样是高频参照物，应该常驻在视线边缘而不是要去翻。
 *
 * 刻意保留 `.wp-row / .wp-label / .wp-link` 这套类名：集成测试断言的就是它们，
 * 换名字等于把「反链到底有没有真的渲染出来」那条用例弄哑。搬位置不该动契约。
 */
import { useMemo } from 'react';
import { extractHeadings } from '../lib/headings';

const COLLAPSE_KEY = 'ivnote.rightPanel.collapsed';

export function loadRightPanelCollapsed(): boolean {
  return localStorage.getItem(COLLAPSE_KEY) === '1';
}
export function saveRightPanelCollapsed(v: boolean): void {
  localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0');
}

interface Props {
  doc: string | null;
  /** 本文引用出去的标题 */
  wikiOut?: string[];
  /** 引用本文的笔记路径 */
  wikiBack?: string[];
  onOpenWiki?(title: string): void;
  onOpenWikiPath?(path: string): void;
  collapsed: boolean;
  /** 由 usePanelWidth 给的宽度（方案 §4.4 可调宽） */
  width?: number;
  onToggle(): void;
}

function titleOf(path: string): string {
  return path.split('/').pop()?.replace(/\.(md|markdown)$/i, '') ?? path;
}

export function RightPanel(props: Props) {
  const headings = useMemo(() => extractHeadings(props.doc ?? ''), [props.doc]);

  if (props.collapsed) {
    return (
      <div className="right-rail">
        <button className="icon-btn" title="展开大纲与反链" onClick={props.onToggle}>
          ‹
        </button>
      </div>
    );
  }

  const out = props.wikiOut ?? [];
  const back = props.wikiBack ?? [];

  return (
    <aside
      className="right-panel"
      style={props.width ? { width: props.width, minWidth: props.width, maxWidth: props.width } : undefined}
    >
      <div className="rp-head">
        <span className="rp-title">大纲</span>
        <button className="icon-btn" title="收起" onClick={props.onToggle}>
          ›
        </button>
      </div>

      <div className="rp-body">
        {headings.length === 0 ? (
          <p className="rp-empty">这篇还没有标题</p>
        ) : (
          <nav className="rp-outline">
            {headings.map((h, i) => (
              <button
                key={`${h.offset}-${i}`}
                className={`rp-h rp-h${h.level}`}
                title={h.text}
                // 复用移动端大纲那条跳转桥：编辑器监听 ivnote-jump(offset)
                onClick={() =>
                  window.dispatchEvent(new CustomEvent('ivnote-jump', { detail: h.offset }))
                }
              >
                {h.text}
              </button>
            ))}
          </nav>
        )}

        {(out.length > 0 || back.length > 0) && (
          <div className="wiki-panel rp-links">
            {out.length > 0 && (
              <div className="wp-row">
                <span className="wp-label">出链</span>
                {out.map((t) => (
                  <button key={t} className="wp-link" onClick={() => props.onOpenWiki?.(t)}>
                    {t}
                  </button>
                ))}
              </div>
            )}
            {back.length > 0 && (
              <div className="wp-row">
                <span className="wp-label">入链</span>
                {back.map((p) => (
                  <button key={p} className="wp-link" onClick={() => props.onOpenWikiPath?.(p)}>
                    {titleOf(p)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

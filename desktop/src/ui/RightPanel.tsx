/**
 * 桌面右栏：大纲 + 双链（v0.7.9 E8）。
 *
 * 移动端早就有大纲浮层和反链区块，桌面反而没有——反链只在编辑区底部挤成一条横排，
 * 大纲干脆没有。写长文时这两样是高频参照物，应该常驻在视线边缘而不是要去翻。
 *
 * 刻意保留 `.wp-row / .wp-label / .wp-link` 这套类名：集成测试断言的就是它们，
 * 换名字等于把「反链到底有没有真的渲染出来」那条用例弄哑。搬位置不该动契约。
 */
import { RibbonIcon } from './Icons';
import { useEffect, useMemo, useState } from 'react';
import { extractHeadings } from '../lib/headings';
import { GraphView } from './GraphView';
import type { SearchDoc } from '../lib/searchIndex';

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
  /**
   * v0.11.16：**图谱是右栏的第三个标签**，不再是一个整屏的新页面。
   *
   * 用户原话：「图谱为什么是一个新的页面？不应该也是在右侧窗口吗」。
   * 看图谱基本都是为了跳到某一篇，整屏那一版每次都要先退出去才回得到正文。
   */
  docs?: SearchDoc[];
  currentPath?: string | null;
  onOpenNote?(path: string): void;
  /** 点「全屏打开」：整屏那一版仍然留着，铺开看全库时它才够用 */
  onExpandGraph?(): void;
  /** 外部（ribbon 那颗图谱按钮）要求切到图谱标签；变一次切一次 */
  graphRequest?: number;
}

function titleOf(path: string): string {
  return path.split('/').pop()?.replace(/\.(md|markdown)$/i, '') ?? path;
}

export function RightPanel(props: Props) {
  const headings = useMemo(() => extractHeadings(props.doc ?? ''), [props.doc]);
  const out = props.wikiOut ?? [];
  const back = props.wikiBack ?? [];
  const [tab, setTab] = useState<'outline' | 'links' | 'graph'>('outline');

  // ribbon 上那颗图谱按钮：展开右栏并切到图谱标签
  const req = props.graphRequest ?? 0;
  useEffect(() => {
    if (req > 0) setTab('graph');
  }, [req]);

  if (props.collapsed) {
    return (
      <div className="right-rail">
        <button className="icon-btn" title="展开大纲与反链" onClick={props.onToggle}>
          <RibbonIcon name="chevron-left" size={16} />
        </button>
      </div>
    );
  }



  return (
    <aside
      className="right-panel"
      style={props.width ? { width: props.width, minWidth: props.width, maxWidth: props.width } : undefined}
    >
      {/* v0.10.0：右栏改成可切换的标签面板（Obsidian 的右栏就是「大纲 / 反向链接」
          两个标签）。此前是「大纲在上、双链挤在下面」一路排下去——长文时大纲一长，
          反链就被推出屏幕，等于没有。 */}
      <div className="rp-head">
        <div className="rp-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'outline'}
            className={`rp-tab ${tab === 'outline' ? 'on' : ''}`}
            onClick={() => setTab('outline')}
          >
            大纲
          </button>
          <button
            role="tab"
            aria-selected={tab === 'links'}
            className={`rp-tab ${tab === 'links' ? 'on' : ''}`}
            onClick={() => setTab('links')}
          >
            反向链接{back.length > 0 ? `（${back.length}）` : ''}
          </button>
          {props.docs && (
            <button
              role="tab"
              aria-selected={tab === 'graph'}
              className={`rp-tab ${tab === 'graph' ? 'on' : ''}`}
              onClick={() => setTab('graph')}
            >
              图谱
            </button>
          )}
        </div>
        <button className="icon-btn" title="收起" onClick={props.onToggle}>
          <RibbonIcon name="chevron-right" size={16} />
        </button>
      </div>

      <div className={`rp-body ${tab === 'graph' ? 'rp-body-graph' : ''}`}>
        {tab === 'graph' && props.docs && (
          <GraphView
            compact
            docs={props.docs}
            currentPath={props.currentPath ?? null}
            onOpenNote={(p) => props.onOpenNote?.(p)}
            onClose={() => setTab('outline')}
            onExpand={props.onExpandGraph}
          />
        )}
        {tab === 'outline' &&
          (headings.length === 0 ? (
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
          ))}

        {tab === 'links' && out.length === 0 && back.length === 0 && (
          <p className="rp-empty">这篇还没有双链。在正文里写 [[笔记名]] 建立联系。</p>
        )}
        {tab === 'links' && (out.length > 0 || back.length > 0) && (
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

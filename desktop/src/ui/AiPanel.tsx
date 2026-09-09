/**
 * AI 结果面板：**先看，再决定要不要写进笔记**（v0.11.18）。
 *
 * # 为什么一定要有这一层
 *
 * 笔记是用户的资产。让模型直接改写文件，等于把"可能改错、可能改味、可能顺手删掉
 * 一句话"的风险全押在一次不可见的调用上——而 Markdown 文件被改坏，往往要等同步到
 * 另一台设备、甚至几天后重读才发现。
 *
 * 所以这个面板做三件事：
 * 1. **流式显示**结果（长文校对十几秒，没有流式按钮就像卡死）；
 * 2. **左右对照**原文与结果，改了哪儿一目了然；
 * 3. 只有点「应用」才写回，随时可以「重试」或直接关掉。
 *
 * 「写摘要 / 起标题」这类不覆盖原文的动作（mode='produce'），按钮是「插入到文末」/
 * 「复制」，绝不会替换任何东西——面板上也明说了它会做什么。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { RibbonIcon } from './Icons';
import { diffLines, type DiffRow } from '../lib/textDiff';
import type { AiActionSpec } from '../lib/llm';

export interface AiPanelProps {
  /** 正在跑的动作；null = 不显示 */
  spec: AiActionSpec | null;
  /** 送进模型的原文（选中的那段，或整篇） */
  source: string;
  /** 已经收到的结果（流式增量由外层累积） */
  result: string;
  /** 还在跑 */
  busy: boolean;
  /** 出错了：一句能照着做的话 */
  error: string | null;
  /** 原文的来源，显示给用户看（"选中的 128 字" / "整篇笔记"） */
  scope: string;
  onApply(): void;
  onRetry(): void;
  onClose(): void;
  /**
   * 把结果复制走。
   *
   * 「问这篇 / 问整个库」的答案多数时候是**看一眼就够**——它不是要写进笔记的内容。
   * 只给「插入到文末」等于逼人把问答记录攒进正文里。
   */
  onCopy?(text: string): void;
}

/** 一行的样式：加了、删了、还是没动 */
function rowClass(r: DiffRow): string {
  return r.kind === 'add' ? 'ai-row add' : r.kind === 'del' ? 'ai-row del' : 'ai-row same';
}

export function AiPanel(props: AiPanelProps) {
  const [tab, setTab] = useState<'diff' | 'result'>('diff');
  const tail = useRef<HTMLDivElement>(null);

  // 流式时把视图钉在末尾，像看它一句句写出来
  useEffect(() => {
    if (props.busy) tail.current?.scrollIntoView({ block: 'end' });
  }, [props.result, props.busy]);

  const rows = useMemo(
    () => (props.spec?.mode === 'replace' ? diffLines(props.source, props.result) : []),
    [props.spec, props.source, props.result]
  );
  const changed = rows.filter((r) => r.kind !== 'same').length;

  if (!props.spec) return null;
  const produce = props.spec.mode === 'produce';

  return (
    <section className="ai-panel" role="dialog" aria-label={`AI ${props.spec.label}`}>
      <header className="ai-head">
        <strong className="ai-title">
          AI · {props.spec.label}
          {props.busy && <span className="ai-dot" aria-label="进行中" />}
        </strong>
        <span className="ai-scope">{props.scope}</span>
        {!produce && !props.busy && !props.error && (
          <span className="ai-count">{changed > 0 ? `${changed} 行有改动` : '没有需要改的'}</span>
        )}
        <span className="ai-gap" />
        {!produce && (
          <div className="ai-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={tab === 'diff'}
              className={`ai-tab ${tab === 'diff' ? 'on' : ''}`}
              onClick={() => setTab('diff')}
            >
              对照
            </button>
            <button
              role="tab"
              aria-selected={tab === 'result'}
              className={`ai-tab ${tab === 'result' ? 'on' : ''}`}
              onClick={() => setTab('result')}
            >
              结果
            </button>
          </div>
        )}
        <button className="icon-btn" title="关闭" aria-label="关闭" onClick={props.onClose}>
          <RibbonIcon name="close" size={15} />
        </button>
      </header>

      <div className="ai-body">
        {props.error ? (
          <p className="ai-error">{props.error}</p>
        ) : produce || tab === 'result' ? (
          <pre className="ai-result">{props.result || (props.busy ? '' : '（空）')}</pre>
        ) : (
          <div className="ai-diff">
            {rows.map((r, i) => (
              <div key={i} className={rowClass(r)}>
                <span className="ai-sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}</span>
                <span className="ai-text">{r.text || ' '}</span>
              </div>
            ))}
          </div>
        )}
        <div ref={tail} />
      </div>

      <footer className="ai-foot">
        <span className="ai-hint">{props.spec.hint}</span>
        <span className="ai-gap" />
        <button className="btn ghost" onClick={props.onRetry} disabled={props.busy}>
          重试
        </button>
        {props.onCopy && (
          <button
            className="btn ghost"
            onClick={() => props.onCopy?.(props.result)}
            disabled={props.busy || !props.result.trim()}
          >
            复制
          </button>
        )}
        <button
          className="btn primary"
          onClick={props.onApply}
          disabled={props.busy || !!props.error || !props.result.trim()}
          title={produce ? '把结果插入到笔记末尾' : '用结果替换原文'}
        >
          {produce ? '插入到文末' : '应用'}
        </button>
      </footer>
    </section>
  );
}

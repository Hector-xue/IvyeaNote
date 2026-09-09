/**
 * 阅读密度：**按内容自动选字号 / 行宽 / 行高**（v0.11.18）。
 *
 * # 为什么不问大模型
 *
 * 用户要的是"自动根据内容调整字号"。这件事看起来像 AI，其实是**排版**：
 * 决定它的是可测量的东西——正文里中文占多少、平均段落多长、有没有大量代码或表格、
 * 标题密不密。让模型每次回答"这篇用 15px 还是 16px"，慢、花钱，而且**同一篇
 * 两次可能给出不同答案**；排版最忌讳的就是不稳定。
 *
 * 这一层是一个纯函数：文本进，档位出。离线、瞬时、可单测、每次一样。
 *
 * # 三个档位怎么定的
 *
 * - **紧凑**：代码/表格占比高的技术笔记。等宽内容按字符对齐，行宽要够、字号要小，
 *   否则一行折两次，代码就读不成句。
 * - **标准**：一般中文笔记。
 * - **宽松**：短句、清单、日记这类"扫读"的内容，字大行疏读起来更省力。
 *
 * 只调这三样，不碰字体与颜色：那是外观设置里用户自己定的事（appearance.ts）。
 */

export type DensityTier = 'compact' | 'normal' | 'relaxed';

export interface DensityMetrics {
  /** 正文中文字符占比（0~1） */
  cjkRatio: number;
  /** 代码块与表格行占全部非空行的比例（0~1） */
  denseRatio: number;
  /** 非空行的平均长度（按字符） */
  avgLineLen: number;
  /** 列表行占比（0~1） */
  listRatio: number;
  /** 非空行数 */
  lines: number;
}

export interface DensityChoice {
  tier: DensityTier;
  /** 正文字号（px）、行宽（px）、行高（倍） */
  fontSize: number;
  measure: number;
  lineHeight: number;
  /** 说人话的理由——自动调整必须解释自己，否则用户只会觉得"字怎么变了" */
  reason: string;
}

const TIERS: Record<DensityTier, Omit<DensityChoice, 'tier' | 'reason'>> = {
  compact: { fontSize: 14, measure: 820, lineHeight: 1.6 },
  normal: { fontSize: 15, measure: 720, lineHeight: 1.75 },
  relaxed: { fontSize: 16, measure: 660, lineHeight: 1.9 },
};

/** 量一段 Markdown 的形状。不做任何判断，只出数字 */
export function measureDoc(src: string): DensityMetrics {
  const lines = src.split('\n');
  let cjk = 0;
  let latin = 0;
  let dense = 0;
  let list = 0;
  let nonEmpty = 0;
  let lenSum = 0;
  let inFence = false;

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      dense++;
      nonEmpty++;
      continue;
    }
    if (!line.trim()) continue;
    nonEmpty++;
    lenSum += line.length;
    if (inFence || /^\s*\|/.test(line) || /^(\t| {4})\S/.test(line)) {
      dense++;
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s/.test(line)) list++;
    for (const ch of line) {
      if (/[一-鿿぀-ヿ㐀-䶿]/.test(ch)) cjk++;
      else if (/[A-Za-z]/.test(ch)) latin++;
    }
  }

  const letters = cjk + latin;
  return {
    cjkRatio: letters ? cjk / letters : 0,
    denseRatio: nonEmpty ? dense / nonEmpty : 0,
    avgLineLen: nonEmpty ? lenSum / nonEmpty : 0,
    listRatio: nonEmpty ? list / nonEmpty : 0,
    lines: nonEmpty,
  };
}

/**
 * 按内容选档。
 *
 * 判据刻意简单且**有先后顺序**——排版规则一旦互相打架就没法解释给用户听：
 * ① 代码/表格多 → 紧凑（这条优先级最高，等宽内容折行最伤）；
 * ② 短行 + 清单多 → 宽松（扫读型）；
 * ③ 其余 → 标准。
 *
 * 太短的文档（不足 8 个非空行）一律标准：样本不够，猜不准，别乱动。
 */
export function pickDensity(src: string): DensityChoice {
  const m = measureDoc(src);
  if (m.lines < 8) {
    return { tier: 'normal', ...TIERS.normal, reason: '内容还太短，保持标准排版' };
  }
  if (m.denseRatio >= 0.25) {
    return {
      tier: 'compact',
      ...TIERS.compact,
      reason: `代码与表格占了 ${Math.round(m.denseRatio * 100)}%，收紧字号、放宽行宽，免得每行折两次`,
    };
  }
  if (m.avgLineLen <= 28 && m.listRatio >= 0.3) {
    return {
      tier: 'relaxed',
      ...TIERS.relaxed,
      reason: '以短句和清单为主，字大行疏更好扫读',
    };
  }
  return {
    tier: 'normal',
    ...TIERS.normal,
    reason: `以${m.cjkRatio >= 0.5 ? '中文' : '西文'}长段落为主，用标准排版`,
  };
}

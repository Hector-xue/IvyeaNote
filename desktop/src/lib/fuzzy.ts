/**
 * 模糊匹配（方案 §4.5 E6，v0.8.4）。
 *
 * 快速切换器此前是 `title.includes(q)` 子串匹配——想开「亚马逊/广告优化」得完整
 * 敲出连续的一段，而人记住的往往是零散几个字（「亚广」「amzad」）。
 *
 * 这里做的是**子序列匹配 + 打分**，不是编辑距离：
 * - 查询字符必须按顺序全部出现，出现即命中（否则会把毫不相干的项也算进来）；
 * - 分数偏向「连续命中」和「命中在词/路径段的开头」——`广告` 匹配「广告优化」
 *   应该排在匹配「推广报告」前面；
 * - 大小写不敏感；中文逐字比较，天然就按字走。
 *
 * 返回命中位置区间，供界面加粗高亮——**没有高亮的模糊匹配是很吓人的**：
 * 用户看不出软件凭什么给出这些结果。
 */

export interface FuzzyResult {
  score: number;
  /** 命中的字符位置区间 [start, end)，已合并相邻项 */
  ranges: [number, number][];
}

/** 词/路径段的分隔符：命中紧跟在这些字符之后算「段首」，加分 */
const BOUNDARY = /[\s/\-_.，。、（）()[\]]/;

export function fuzzyMatch(text: string, query: string): FuzzyResult | null {
  const q = query.trim();
  if (q === '') return { score: 0, ranges: [] };

  const t = text.toLowerCase();
  const qq = q.toLowerCase();

  const hits: number[] = [];
  let ti = 0;
  for (const ch of qq) {
    if (ch === ' ') continue; // 空格只作分隔，不参与匹配
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    hits.push(found);
    ti = found + 1;
  }
  if (hits.length === 0) return { score: 0, ranges: [] };

  let score = 0;
  let prev = -2;
  for (const i of hits) {
    if (i === prev + 1) score += 8; // 连续命中：最强的信号
    else score += 1;
    if (i === 0) score += 6; // 开头
    else if (BOUNDARY.test(text[i - 1])) score += 4; // 段首（目录分隔、空格、连字符）
    prev = i;
  }
  // 命中越靠前、匹配得越紧凑越好（同分时短标题优先）
  score += Math.max(0, 20 - hits[0]);
  score -= Math.floor((hits[hits.length - 1] - hits[0] - hits.length + 1) / 2);

  // 合并相邻位置成区间，界面按区间加粗
  const ranges: [number, number][] = [];
  for (const i of hits) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else ranges.push([i, i + 1]);
  }
  return { score, ranges };
}

/** 按区间把文本切成「命中 / 非命中」交替的段，供渲染 */
export function splitByRanges(
  text: string,
  ranges: readonly [number, number][]
): { text: string; hit: boolean }[] {
  if (ranges.length === 0) return text ? [{ text, hit: false }] : [];
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const [s, e] of ranges) {
    if (s > at) out.push({ text: text.slice(at, s), hit: false });
    out.push({ text: text.slice(s, e), hit: true });
    at = e;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

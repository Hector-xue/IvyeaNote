/**
 * 「问整个笔记库」的取材层（v0.11.20）。
 *
 * # 这一步为什么必须是本地的
 *
 * 用户问「我去年关于定价那套结论是什么来着」，模型只有读到那几篇笔记才答得上来。
 * 但**不能把整个库发出去**——几千篇笔记、几百万字，既贵又慢，更重要的是：
 * 那是他的全部私人资料，为了回答一个问题就整体外传，这笔账怎么算都不划算。
 *
 * 所以先在本地检索：挑出**最可能相关的几篇**，每篇再截取**问题附近的那一段**，
 * 拼起来才发出去。默认上限五篇、六千字——一次问答的成本因此是可预期的，
 * 界面上也说得出「送了哪几篇、多少字」。
 *
 * # 为什么不直接用 searchNotes
 *
 * `searchNotes` 是 **AND** 语义：所有查询词都得命中才进候选。这对搜索框是对的
 * （人敲的是关键词），对问句是**灾难**——「我去年关于定价那套结论是什么来着」
 * 切出十几个二元组，没有哪篇笔记会全中，结果是零命中、零上下文，
 * 模型只好开始编。这里要的是 **OR + 打分排序**：命中得越多、越罕见，排得越前。
 *
 * # 为什么要"截一段"而不是"发整篇"
 *
 * 一篇长笔记里真正相关的往往是其中十几行。整篇塞进去，一是挤掉别的笔记的位置，
 * 二是把模型的注意力摊薄。所以按行打分，取分数最高那一段的**前后文**——
 * 上下文窗口给得再大，选材不准也是白搭。
 *
 * 纯函数：不碰网络、不碰磁盘，可以单测到每一条规则。
 */
import { tokenizeQuery } from './tokenize';
import type { SearchDoc } from './searchIndex';

export interface Passage {
  /** 库内路径，答案里用它做出处 */
  path: string;
  /** 截出来的那一段正文 */
  text: string;
  /** 相关度（只用于排序与调试，不给用户看绝对值） */
  score: number;
  /** 这一段在原文里的起始行号（1 起），方便以后做"跳到这一行" */
  line: number;
}

export interface RetrieveOptions {
  /** 最多取几篇 */
  maxDocs?: number;
  /** 每篇最多截多少字 */
  maxCharsPerDoc?: number;
  /** 所有段落加起来的字数上限 */
  maxTotalChars?: number;
}

const DEFAULTS: Required<RetrieveOptions> = {
  maxDocs: 5,
  maxCharsPerDoc: 1600,
  maxTotalChars: 6000,
};

/** 文件名（去目录与扩展名）——标题命中要单独加权 */
function titleOf(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.(md|markdown)$/i, '').toLowerCase();
}

/**
 * 问句里的词。
 *
 * 单字 CJK 词（前缀词）一律丢掉：「的」「是」「个」这种字满库都是，
 * 既不能区分文档，还会把长文档整体抬上来。二元组已经够细了。
 */
function queryTerms(question: string): string[] {
  const seen = new Set<string>();
  for (const t of tokenizeQuery(question)) {
    if (t.prefix) continue;
    seen.add(t.term);
  }
  return [...seen];
}

/** 一个词在文本里出现几次（文本已小写） */
function countOf(text: string, term: string): number {
  let n = 0;
  let at = text.indexOf(term);
  while (at !== -1) {
    n++;
    at = text.indexOf(term, at + term.length);
  }
  return n;
}

/**
 * 取材。
 *
 * 打分用 IDF × 饱和的词频：
 * - **IDF**：一个词出现在越少的笔记里，命中它越说明问题——「定价」比「一个」值钱得多；
 * - **饱和**（`tf / (tf + 2)`）：同一个词出现二十次不该比出现三次强二十倍，
 *   否则一篇通篇讲这个词的流水账会永远压过真正给出结论的那篇；
 * - **标题命中**额外加权：笔记名就叫「定价策略」几乎必然相关。
 */
export function retrieve(
  docs: readonly SearchDoc[],
  question: string,
  options: RetrieveOptions = {}
): Passage[] {
  const opts = { ...DEFAULTS, ...options };
  const terms = queryTerms(question);
  if (terms.length === 0 || docs.length === 0) return [];

  const lowered = docs.map((d) => d.content.toLowerCase());
  const titles = docs.map((d) => titleOf(d.path));

  // 文档频率：这个词出现在多少篇里
  const df = new Map<string, number>();
  for (const term of terms) {
    let n = 0;
    for (let i = 0; i < docs.length; i++) if (lowered[i].includes(term) || titles[i].includes(term)) n++;
    df.set(term, n);
  }

  const idf = (term: string) => Math.log(1 + (docs.length - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));

  const scored = docs.map((doc, i) => {
    let score = 0;
    for (const term of terms) {
      const tf = countOf(lowered[i], term);
      if (tf > 0) score += idf(term) * (tf / (tf + 2));
      if (titles[i].includes(term)) score += idf(term) * 1.5;
    }
    return { doc, score, i };
  });

  const picked = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.maxDocs);

  const out: Passage[] = [];
  let total = 0;
  for (const p of picked) {
    const budget = Math.min(opts.maxCharsPerDoc, opts.maxTotalChars - total);
    if (budget < 200) break; // 剩下的额度装不下一段有意义的上下文，就别硬塞
    const cut = bestWindow(p.doc.content, terms, budget);
    if (!cut.text.trim()) continue;
    out.push({ path: p.doc.path, text: cut.text, score: p.score, line: cut.line });
    total += cut.text.length;
  }
  return out;
}

/**
 * 从一篇笔记里截出最相关的一段。
 *
 * 按行打分（这一行命中了几个不同的查询词），然后以最高分那一行为中心向两侧扩，
 * 直到用满字数预算。**按行扩而不是按字符扩**：从句子中间切开的上下文，
 * 模型读起来和人一样费劲。
 */
export function bestWindow(
  content: string,
  terms: string[],
  budget: number
): { text: string; line: number } {
  const lines = content.split('\n');
  const lower = lines.map((l) => l.toLowerCase());
  const hits = lower.map((l) => terms.reduce((n, t) => n + (l.includes(t) ? 1 : 0), 0));

  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < lines.length; i++) {
    // 三行窗口：结论常常在命中行的下一行（"所以……"）
    const s = (hits[i] ?? 0) * 2 + (hits[i + 1] ?? 0) + (hits[i - 1] ?? 0);
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  // 一个词都没命中（只有标题命中）：那就给开头，开头通常是这篇在讲什么
  if (bestScore <= 0) return { text: clip(content, budget), line: 1 };

  let from = best;
  let to = best;
  let size = lines[best].length;
  // 向两边交替扩，先扩后面——后文往往是结论
  while (size < budget && (from > 0 || to < lines.length - 1)) {
    if (to < lines.length - 1 && size + lines[to + 1].length + 1 <= budget) {
      to++;
      size += lines[to].length + 1;
    } else if (from > 0 && size + lines[from - 1].length + 1 <= budget) {
      from--;
      size += lines[from].length + 1;
    } else break;
  }
  return { text: lines.slice(from, to + 1).join('\n'), line: from + 1 };
}

/** 截断到预算内，尽量断在换行处 */
function clip(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const cut = text.slice(0, budget);
  const nl = cut.lastIndexOf('\n');
  return nl > budget * 0.5 ? cut.slice(0, nl) : cut;
}

/** 送出去的字数（界面上要如实说"这次发了多少"） */
export function totalChars(passages: readonly Passage[]): number {
  return passages.reduce((n, p) => n + p.text.length, 0);
}

/**
 * 分词：中英混排的检索切分。
 *
 * 为什么自己写而不是用 SQLite FTS5 的内置分词器——这是 v0.8.0 的一个明确决策：
 * - `trigram` 分词器要求查询词 ≥3 字符，「广告」「定价」这类二字词根本搜不到；
 * - `simple`/`icu` 分词器要编译 SQLite 扩展，前端拿不到；
 * - 而 tauri-plugin-sql 是 Rust 依赖，本项目的开发机编译不了 Tauri，
 *   加了就等于写下无法验证的代码。
 *
 * 所以走通用做法：**CJK 切二元组（bigram），拉丁文按词切**，索引和查询用同一套切法。
 * 二元组能保证「广告」「多智能体」这类词精确命中，代价是索引条目多一些——
 * 个人笔记规模（几千篇）完全吃得下。
 */

/**
 * 中日韩表意文字 + 假名。用码点转义而不是字面字符——源文件编码一旦出问题，
 * 字面写法会静默变成错误的区间，而分词错了只表现为「搜不到」，极难排查。
 * 刻意不含中日韩标点（U+3000–U+303F），标点必须当分隔符。
 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
/** 拉丁字母、数字、以及会出现在标识符里的连接符 */
const WORD = /[a-z0-9_]/;

function isCJK(ch: string): boolean {
  return CJK.test(ch);
}

/**
 * 把文本切成检索词。
 *
 * - 拉丁/数字连续段 → 整个词（`ACoS`→`acos`、`gpt-4`→`gpt`,`4`）
 * - CJK 连续段 → 相邻二元组（`多智能体`→`多智`,`智能`,`能体`）
 * - 单字 CJK 段（如「猫」）→ 该字本身，否则单字笔记搜不到
 * - 其余字符（空白、标点、符号）一律当分隔符
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const s = text.toLowerCase();
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (isCJK(ch)) {
      let j = i;
      while (j < s.length && isCJK(s[j])) j++;
      const run = s.slice(i, j);
      if (run.length === 1) out.push(run);
      else for (let k = 0; k + 1 < run.length; k++) out.push(run.slice(k, k + 2));
      i = j;
    } else if (WORD.test(ch)) {
      let j = i;
      while (j < s.length && WORD.test(s[j])) j++;
      out.push(s.slice(i, j));
      i = j;
    } else {
      i++;
    }
  }
  return out;
}

/**
 * 查询切分。与 `tokenize` 同一套规则——索引和查询切法必须一致，
 * 否则「索引里存的是二元组、查询按整词找」会一个都命中不了。
 *
 * 单个 CJK 字的查询单独标记：它在索引里可能只作为二元组的一半存在，
 * 需要走前缀匹配而不是精确匹配。
 */
export interface QueryTerm {
  term: string;
  /** true = 只能按前缀匹配（单个 CJK 字，或拉丁词的前缀补全） */
  prefix: boolean;
}

export function tokenizeQuery(text: string): QueryTerm[] {
  const raw = tokenize(text);
  return raw.map((t) => ({
    term: t,
    // 单个 CJK 字在索引里通常只以二元组的首字出现，必须前缀匹配
    prefix: t.length === 1 && isCJK(t),
  }));
}

/** 词数统计用：返回去重后的词表大小（供索引体积估算） */
export function uniqueTerms(text: string): Set<string> {
  return new Set(tokenize(text));
}

/**
 * 全库检索引擎（v0.8.0 重写）。
 *
 * v0.7.x 的实现是「把每篇笔记的正文小写化后做 `String.includes` 全扫」，两个真问题：
 * 1. **慢**：每次查询都把全库正文重扫一遍，1 万篇就是几十 MB 的字符串扫描；
 * 2. **排序假**：`score += min(出现次数, 5)`，没有 IDF、没有长度归一化，
 *    于是常见词和罕见词同权、长文永远压过短文。
 *
 * 现在改成**倒排索引 + BM25 排序**：
 * - 分词见 `tokenize.ts`（CJK 二元组 / 拉丁按词），索引与查询同一套切法；
 * - 索引按 docs 数组身份缓存（WeakMap）——`useNoteIndex` 的 docs 只在索引真变了
 *   才换新引用，所以连续敲键只建一次索引，之后每次查询只查倒排表；
 * - 对外签名保持不变，消费方（命令面板 / 标签面板 / 图谱）一行都不用改。
 *
 * ⚠️ 诚实说明两点，别把这次改动说大：
 * - 二元组切分**不解决词边界**——搜「告优」照样命中「广告优化」，因为「告优」确实是
 *   它的一个二元组。要真词边界得上词典分词（jieba 之类），是另一个量级的依赖，本阶段不做。
 *   这次拿到的是**速度和排序质量**，不是切词精度。
 * - 标题匹配仍然逐篇扫（`titles.forEach`），是 O(全库)。但标题只有几十字符，
 *   1 万篇约 1ms 级；被干掉的是「扫几十 MB 正文」那部分。
 *
 * 明确不做 SQLite FTS5：见 `tokenize.ts` 顶部的决策说明。
 */import { tokenize, tokenizeQuery } from './tokenize';
import { extractTags } from './tags';

export interface SearchDoc {
  path: string;
  content: string;
}

export interface SearchHit {
  path: string;
  score: number;
  /** 命中行预览（最多 2 行） */
  preview: string[];
}

export interface SearchQuery {
  text: string;
  phrase?: string; // "精确短语"
  pathFilter?: string; // path:目录
  tagFilter?: string; // tag:标签
}

/** 解析查询串：支持 "短语"、path:xxx、tag:xxx */
export function parseQuery(raw: string): SearchQuery {
  let text = raw;
  let phrase: string | undefined;
  let pathFilter: string | undefined;
  let tagFilter: string | undefined;
  const phraseM = text.match(/"([^"]+)"/);
  if (phraseM) {
    phrase = phraseM[1].toLowerCase();
    text = text.replace(phraseM[0], ' ');
  }
  const pathM = text.match(/path:(\S+)/);
  if (pathM) {
    pathFilter = pathM[1].toLowerCase();
    text = text.replace(pathM[0], ' ');
  }
  const tagM = text.match(/tag:(\S+)/);
  if (tagM) {
    tagFilter = tagM[1].toLowerCase().replace(/^#/, '');
    text = text.replace(tagM[0], ' ');
  }
  return { text: text.trim().toLowerCase(), phrase, pathFilter, tagFilter };
}

// ---------------------------------------------------------------------------
// 倒排索引

interface IndexData {
  /** term → (docIdx → 词频) */
  postings: Map<string, Map<number, number>>;
  /** 排序后的词表，供单字 CJK 查询做前缀展开 */
  sortedTerms: string[];
  /** 每篇的 token 数（BM25 长度归一化用） */
  lens: number[];
  /** 每篇的小写标题（不含扩展名），标题命中要加权 */
  titles: string[];
  /** 每篇的标签集合（tag: 过滤用，建索引时算一次） */
  tags: Set<string>[];
  avgLen: number;
  n: number;
}

/** 索引按 docs 数组身份缓存：连续敲键只建一次 */
const CACHE = new WeakMap<object, IndexData>();

function titleOf(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.(md|markdown)$/i, '').toLowerCase();
}

function buildIndex(docs: readonly SearchDoc[]): IndexData {
  const postings = new Map<string, Map<number, number>>();
  const lens: number[] = [];
  const titles: string[] = [];
  const tags: Set<string>[] = [];
  let total = 0;

  docs.forEach((doc, i) => {
    const toks = tokenize(doc.content);
    lens.push(toks.length);
    total += toks.length;
    titles.push(titleOf(doc.path));
    tags.push(new Set(extractTags(doc.content).map((t) => t.toLowerCase())));
    for (const t of toks) {
      let m = postings.get(t);
      if (!m) {
        m = new Map();
        postings.set(t, m);
      }
      m.set(i, (m.get(i) ?? 0) + 1);
    }
  });

  return {
    postings,
    sortedTerms: [...postings.keys()].sort(),
    lens,
    titles,
    tags,
    avgLen: docs.length ? total / docs.length : 0,
    n: docs.length,
  };
}

function getIndex(docs: readonly SearchDoc[]): IndexData {
  const key = docs as unknown as object;
  let idx = CACHE.get(key);
  if (!idx) {
    idx = buildIndex(docs);
    CACHE.set(key, idx);
  }
  return idx;
}

/** 二分找到第一个 >= prefix 的词，然后顺序取所有以 prefix 开头的词 */
function expandPrefix(sortedTerms: string[], prefix: string, cap = 64): string[] {
  let lo = 0;
  let hi = sortedTerms.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedTerms[mid] < prefix) lo = mid + 1;
    else hi = mid;
  }
  const out: string[] = [];
  for (let i = lo; i < sortedTerms.length && out.length < cap; i++) {
    if (!sortedTerms[i].startsWith(prefix)) break;
    out.push(sortedTerms[i]);
  }
  return out;
}

const K1 = 1.2;
const B = 0.75;
/** 标题命中的加权。远高于单个词的 BM25 分（通常 0.5~2），保证「标题匹配」稳压「正文匹配」 */
const TITLE_BOOST = 6;

/** 搜索：返回按相关度排序的命中 */
export function searchNotes(
  docs: readonly SearchDoc[],
  raw: string,
  limit = 30
): SearchHit[] {
  const q = parseQuery(raw);
  if (!q.text && !q.phrase) return [];

  const idx = getIndex(docs);
  const qTerms = tokenizeQuery(q.text);

  // 每个查询词展开成「索引里实际存在的词」列表（单字 CJK 走前缀展开）
  const expanded = qTerms.map((t) =>
    t.prefix ? expandPrefix(idx.sortedTerms, t.term) : idx.postings.has(t.term) ? [t.term] : []
  );

  // 候选集 = 满足全部查询词的文档（AND 语义）。标题命中也算该词匹配。
  const scores = new Map<number, number>();
  let candidates: Set<number> | null = null;

  qTerms.forEach((qt, qi) => {
    const hitDocs = new Set<number>();
    for (const term of expanded[qi]) {
      const posting = idx.postings.get(term);
      if (!posting) continue;
      const df = posting.size;
      const idf = Math.log(1 + (idx.n - df + 0.5) / (df + 0.5));
      for (const [d, tf] of posting) {
        hitDocs.add(d);
        const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + (B * idx.lens[d]) / (idx.avgLen || 1)));
        scores.set(d, (scores.get(d) ?? 0) + idf * norm);
      }
    }
    // 标题命中：正文里没有也算这个词匹配上了，并给高加权
    idx.titles.forEach((title, d) => {
      if (title.includes(qt.term)) {
        hitDocs.add(d);
        scores.set(d, (scores.get(d) ?? 0) + TITLE_BOOST);
      }
    });
    candidates = candidates === null ? hitDocs : intersect(candidates, hitDocs);
  });

  // 纯短语查询（没有普通词）：候选是全部文档，交给下面的短语过滤收敛
  let pool: number[];
  if (candidates === null) pool = docs.map((_, i) => i);
  else pool = [...(candidates as Set<number>)];

  const hits: SearchHit[] = [];
  for (const d of pool) {
    const doc = docs[d];
    if (q.pathFilter && !doc.path.toLowerCase().includes(q.pathFilter)) continue;
    if (q.tagFilter && !idx.tags[d].has(q.tagFilter)) continue;
    // 短语必须在正文里逐字出现——倒排表只能保证「词都在」，保证不了「连在一起」
    if (q.phrase && !doc.content.toLowerCase().includes(q.phrase)) continue;
    hits.push({
      path: doc.path,
      score: scores.get(d) ?? (q.phrase ? 5 : 0),
      preview: previewLines(doc.content, qTerms.map((t) => t.term), q.phrase),
    });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

function intersect(a: Set<number>, b: Set<number>): Set<number> {
  const out = new Set<number>();
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const v of small) if (big.has(v)) out.add(v);
  return out;
}

/** 命中行预览（最多 2 行）。按原始子串找，CJK 二元组本身就是正文的子串。 */
function previewLines(content: string, terms: string[], phrase?: string): string[] {
  const out: string[] = [];
  for (const line of content.split('\n')) {
    const ll = line.toLowerCase();
    if (terms.some((t) => t && ll.includes(t)) || (phrase && ll.includes(phrase))) {
      out.push(line.trim().slice(0, 80));
      if (out.length >= 2) break;
    }
  }
  return out;
}

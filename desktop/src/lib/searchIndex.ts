/**
 * v0.7.0 F1：全库搜索（内存索引）。
 * - buildSearchIndex：扫描全部笔记内容建倒排结构（path -> 全文小写缓存）
 * - searchNotes：标题命中加权 > 正文命中；支持 "精确短语" 与 path:目录 过滤
 * 文件量 <1 万时内存索引足够快；FTS5 留给后续版本。
 */

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
}

/** 解析查询串：支持 "短语" 与 path:xxx */
export function parseQuery(raw: string): SearchQuery {
  let text = raw;
  let phrase: string | undefined;
  let pathFilter: string | undefined;
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
  return { text: text.trim().toLowerCase(), phrase, pathFilter };
}

/** 搜索：返回按相关度排序的命中 */
export function searchNotes(docs: SearchDoc[], raw: string, limit = 30): SearchHit[] {
  const q = parseQuery(raw);
  if (!q.text && !q.phrase) return [];
  const terms = q.text.split(/\s+/).filter(Boolean);
  const hits: SearchHit[] = [];

  for (const doc of docs) {
    if (q.pathFilter && !doc.path.toLowerCase().includes(q.pathFilter)) continue;
    const lower = doc.content.toLowerCase();
    const title = (doc.path.split('/').pop() ?? doc.path).replace(/\.(md|markdown)$/i, '').toLowerCase();

    if (q.phrase && !lower.includes(q.phrase)) continue;

    let score = 0;
    let allTermsHit = true;
    for (const t of terms) {
      const inTitle = title.includes(t);
      const inBody = lower.includes(t);
      if (!inTitle && !inBody) {
        allTermsHit = false;
        break;
      }
      score += inTitle ? 10 : 2;
      // 出现次数加成（封顶避免长文档偏置）
      const count = lower.split(t).length - 1;
      score += Math.min(count, 5);
    }
    if (terms.length > 0 && !allTermsHit) continue;
    if (terms.length === 0 && q.phrase) score = 5; // 纯短语查询

    // 命中行预览
    const preview: string[] = [];
    for (const line of doc.content.split('\n')) {
      const ll = line.toLowerCase();
      if (terms.some((t) => ll.includes(t)) || (q.phrase && ll.includes(q.phrase))) {
        preview.push(line.trim().slice(0, 80));
        if (preview.length >= 2) break;
      }
    }
    hits.push({ path: doc.path, score, preview });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

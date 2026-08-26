/**
 * v0.7.0 F4：标签系统。
 * - extractTags：正文 #标签（非标题、非纯数字）+ frontmatter tags:
 * - buildTagIndex：全库标签 → 笔记列表
 */

/** 提取一篇笔记的标签（去重） */
export function extractTags(md: string): string[] {
  const tags = new Set<string>();

  // frontmatter tags: [a, b] 或逐行 - tag
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    const m = fm[1].match(/^tags:\s*\[(.*?)\]/m);
    if (m) {
      for (const t of m[1].split(',')) {
        const v = t.trim().replace(/^['"]|['"]$/g, '');
        if (v) tags.add(v);
      }
    } else {
      const block = fm[1].match(/^tags:\s*$([\s\S]*?)(?=^\w+:|\Z)/m);
      if (block) {
        for (const line of block[1].split('\n')) {
          const t = line.replace(/^[-\s]+/, '').trim();
          if (t) tags.add(t);
        }
      }
    }
  }

  // 正文 #标签：行首或空白后，# 后跟非空白，且不是标题（## 或行首 # 后有空格）
  const re = /(^|[\s(（【])#([^\s#.,;:!?，。；：！？)）】]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    const tag = m[2];
    if (tag && !/^\d+$/.test(tag)) tags.add(tag);
  }
  return [...tags];
}

export interface TagDoc {
  path: string;
  content: string;
}

/** 全库标签索引：标签 → 笔记路径列表（按路径排序） */
export function buildTagIndex(docs: TagDoc[]): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  for (const doc of docs) {
    for (const tag of extractTags(doc.content)) {
      const list = idx.get(tag) ?? [];
      list.push(doc.path);
      idx.set(tag, list);
    }
  }
  for (const [k, v] of idx) idx.set(k, [...new Set(v)].sort());
  return idx;
}

/**
 * 把标签写进 frontmatter（v0.11.20）。
 *
 * 「生成标签」原来只把 `#标签一 #标签二` 附到文末。能用，但**不是标签该待的地方**：
 * 正文末尾多一行井号，导出、打印、分享时都会跟着出去，而它本来是元数据。
 * 库里已有的笔记多数把 tags 写在 frontmatter 里（`lib/tags` 两种形状都认），
 * 新生成的标签就该落到同一个地方，否则同一个库里两套写法。
 *
 * # 三条规则
 *
 * 1. **只增不删**：已有的标签一个都不动。模型漏想到的不等于用户不要。
 * 2. **跟着这篇笔记已有的写法走**：`tags: [a, b]` 就继续写成一行，
 *    `- a` 的块状写法就继续补行。改写法等于替用户做决定，而且 diff 会很难看。
 * 3. **解析不了就不动**：frontmatter 写坏的笔记，宁可什么都不做，也不能把它覆盖掉。
 *
 * 纯函数，可单测到每一种形状。
 */

/** 去掉井号与空白，丢掉空串，按出现顺序去重 */
export function normalizeTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const t = raw.trim().replace(/^#+/, '').trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** 从模型的回复里挑出标签：`#a #b`、`a, b`、每行一个都认 */
export function parseTagReply(reply: string): string[] {
  const hashed = reply.match(/#[^\s#,，、]+/g);
  if (hashed && hashed.length > 0) return normalizeTags(hashed);
  return normalizeTags(reply.split(/[\n,，、]/));
}

const FM = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

export interface MergeResult {
  content: string;
  /** 这次真正新加进去的标签（一个都没加时为空——上层据此说"已经都有了"） */
  added: string[];
}

/**
 * 把 tags 合进 frontmatter。没有 frontmatter 就在最前面建一段。
 */
export function mergeTags(content: string, tags: readonly string[]): MergeResult {
  const want = normalizeTags(tags);
  if (want.length === 0) return { content, added: [] };

  const m = FM.exec(content);
  if (!m) {
    // 没有 frontmatter：建一段。空行是给正文留的呼吸，也避免和紧跟的标题粘在一起
    const block = `---\ntags: [${want.join(', ')}]\n---\n\n`;
    return { content: block + content.replace(/^\r?\n+/, ''), added: want };
  }

  const body = m[1];
  const inline = /^tags:[ \t]*\[(.*)\][ \t]*$/m.exec(body);
  if (inline) {
    const have = normalizeTags(inline[1].split(',').map((t) => t.replace(/^['"]|['"]$/g, '')));
    const added = want.filter((t) => !have.some((h) => h.toLowerCase() === t.toLowerCase()));
    if (added.length === 0) return { content, added: [] };
    const line = `tags: [${[...have, ...added].join(', ')}]`;
    return { content: content.replace(inline[0], line), added };
  }

  // 块状：tags: 之后若干行 `- 标签`
  const blockHead = /^tags:[ \t]*$/m.exec(body);
  if (blockHead) {
    const lines = body.split('\n');
    const at = lines.findIndex((l) => /^tags:[ \t]*$/.test(l));
    let end = at + 1;
    const have: string[] = [];
    while (end < lines.length && /^[ \t]*-[ \t]*\S/.test(lines[end])) {
      have.push(lines[end].replace(/^[ \t]*-[ \t]*/, '').trim());
      end++;
    }
    const added = want.filter((t) => !have.some((h) => h.toLowerCase() === t.toLowerCase()));
    if (added.length === 0) return { content, added: [] };
    // 缩进照抄上一行，别在同一段里混两种缩进
    const indent = end > at + 1 ? (/^[ \t]*/.exec(lines[at + 1])?.[0] ?? '  ') : '  ';
    lines.splice(end, 0, ...added.map((t) => `${indent}- ${t}`));
    return { content: content.replace(body, lines.join('\n')), added };
  }

  // 有 frontmatter 但没有 tags：补一行在这段末尾
  const nextBody = `${body}\ntags: [${want.join(', ')}]`;
  return { content: content.replace(body, nextBody), added: want };
}

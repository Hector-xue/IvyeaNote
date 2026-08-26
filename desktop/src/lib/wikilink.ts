/**
 * v0.7.0 F3：双链（wiki links）。
 * - extractLinks：提取一篇笔记的全部 [[目标]] / [[目标|别名]] 出链
 * - buildBacklinks：全库反查入链
 * - renderWikiLinks：阅读模式把 [[xxx]] 渲染成可点链接（HTML 字符串后处理）
 */

/** 提取正文全部出链目标（去重；别名取目标名） */
export function extractLinks(md: string): string[] {
  const out = new Set<string>();
  const re = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    out.add(m[1].trim());
  }
  return [...out];
}

/** 由笔记路径得到可被 [[]] 引用的标题（basename 去后缀） */
export function titleOfPath(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.(md|markdown)$/i, '');
}

/**
 * 全库反链索引：title -> 引用它的笔记路径列表。
 * titles：path -> 标题映射（一个笔记可被标题或路径引用）。
 */
export function buildBacklinks(
  docs: { path: string; content: string }[],
  titles: Map<string, string>
): Map<string, string[]> {
  const byTitle = new Map<string, string[]>();
  for (const doc of docs) {
    const links = extractLinks(doc.content);
    for (const target of links) {
      // 目标 → 找到对应 path（按标题匹配；无匹配也记录，供「未创建」提示）
      let targetPath: string | undefined;
      for (const [p, t] of titles) {
        if (t === target) {
          targetPath = p;
          break;
        }
      }
      const key = targetPath ?? target;
      const list = byTitle.get(key) ?? [];
      list.push(doc.path);
      byTitle.set(key, [...new Set(list)]);
    }
  }
  return byTitle;
}

/** 阅读模式后处理：把 [[target|alias]] 替换成 <a class="wikilink" data-target="...">alias</a>。
 * 在 DOMPurify 之后调用（生成的属性是安全的）。 */
export function renderWikiLinks(html: string, resolveHref: (target: string) => string): string {
  return html.replace(
    /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g,
    (_, target: string, alias?: string) => {
      const t = target.trim();
      const text = (alias ?? t).trim();
      return `<a class="wikilink" data-target="${t.replace(/"/g, '&quot;')}" href="${resolveHref(t)}">${text}</a>`;
    }
  );
}

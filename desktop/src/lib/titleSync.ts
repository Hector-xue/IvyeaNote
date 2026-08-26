/**
 * v0.4.0 T3：标题 ↔ 文件名联动（对标 Obsidian）。
 * - 新建笔记即时创建 untitled.md（重名自动序号）
 * - 正文首个 # 标题变化时自动重命名文件
 */

/** 从 Markdown 提取第一个 H1 标题文本；无 H1 返回 null */
export function extractH1(md: string): string | null {
  const lines = md.split('\n');
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m) {
      // 去掉行内格式标记与 [[wiki 链接]] 包裹
      return m[1]
        .replace(/\[\[(?:[^\]|]*)\|?([^\]]*)\]\]/g, '$1')
        .replace(/[*_`~]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }
    // H1 只认文档前部：遇到其他内容（非空非注释非前置标题）即停止
    if (line.trim() !== '' && !line.startsWith('#')) break;
  }
  return null;
}

/** 文件系统非法字符清洗 + 去首尾空白/点；空结果返回 fallback */
export function sanitizeTitle(title: string, fallback = 'untitled'): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|#^[\]]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}

/** 由标题生成相对路径（保留原目录），强制 .md 后缀 */
export function titleToPath(oldPath: string, title: string): string {
  const idx = oldPath.lastIndexOf('/');
  const dir = idx > 0 ? `${oldPath.slice(0, idx)}/` : '';
  return `${dir}${sanitizeTitle(title)}.md`;
}

/**
 * 在 existing 集合中为 baseName（不含扩展名）找唯一名：
 * untitled.md → untitled 1.md → untitled 2.md …
 */
export function uniqueName(baseName: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  if (!taken.has(`${baseName}.md`)) return `${baseName}.md`;
  for (let i = 1; ; i++) {
    const candidate = `${baseName} ${i}.md`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** 判断两个路径是否指向同一个文件（大小写不敏感比较 basename） */
export function sameTitlePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

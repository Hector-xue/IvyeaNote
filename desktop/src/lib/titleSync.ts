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

/**
 * 把正文里**第一个 H1** 换成新标题；没有 H1 就原样返回。
 *
 * 为什么需要它：用户显式改了标题（内联标题 / 重命名）之后，正文里的 H1 还是旧的，
 * 而 `titleSync` 是「H1 → 文件名」的单向同步 —— 下一次编辑就会把文件名改回 H1，
 * 表现是**「标题改了又自己变回去」**（2026-09-08 用户反馈）。改名时顺手把 H1 带上，
 * 两边就再也不会打架。
 *
 * 只动第一行那个 H1，围栏代码块里的 `# xxx` 不算（和 extractH1 同一套判定）。
 */
export function replaceFirstH1(md: string, title: string): string {
  const lines = md.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^#\s+(.+?)\s*$/.test(line)) {
      lines[i] = `# ${title}`;
      return lines.join('\n');
    }
    if (line.trim() !== '' && !line.startsWith('#')) break;
  }
  return md;
}

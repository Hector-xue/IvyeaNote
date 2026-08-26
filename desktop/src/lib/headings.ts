/**
 * v0.7.3 P6：从 Markdown 源码提取标题大纲（heading + 文档偏移）。
 * 供移动端大纲浮层跳转使用；忽略代码块内的 # 行。
 */
export interface HeadingItem {
  level: number;
  text: string;
  /** 标题行在源码中的起始偏移（编辑器 scrollPos 定位用） */
  offset: number;
}

export function extractHeadings(md: string): HeadingItem[] {
  const out: HeadingItem[] = [];
  let inFence = false;
  let offset = 0;
  for (const raw of md.split('\n')) {
    const line = raw;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
    } else if (!inFence) {
      const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (m) out.push({ level: m[1].length, text: m[2], offset });
    }
    offset += line.length + 1; // +1 为换行符
  }
  return out;
}

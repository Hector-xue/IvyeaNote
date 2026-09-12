/**
 * 桌面小部件用的笔记预览文本（v0.11.30）。
 *
 * 小部件只能放纯文本（RemoteViews 的 TextView），而笔记是 Markdown：
 * 井号、星号、链接方括号原样摆上去，一张卡片就成了源码。这里把常见记号剥掉，
 * 只保留人读的那部分——不追求完整的 Markdown 解析，追求"看着像那篇笔记"。
 *
 * 纯函数，无 DOM。
 */

/** 预览最多保留多少字符。4×4 的卡片也就三四十行，再多只是白白撑大 SharedPreferences */
export const PREVIEW_MAX = 1200;

export function widgetPreview(markdown: string, max = PREVIEW_MAX): string {
  let text = markdown.replace(/\r\n?/g, '\n');
  // YAML frontmatter：整块去掉（tags/date 这类元数据不该出现在卡片上）
  text = text.replace(/^---\n[\s\S]*?\n---\n?/, '');
  // 代码围栏只去标记行，保留代码本身（用户可能就是在记命令）
  text = text.replace(/^\s*(```|~~~)[^\n]*$/gm, '');
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    let line = raw;
    // 图片：整个去掉（卡片放不下，留个"![]"只会碍眼）
    line = line.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
    // 任务框：☐ / ☑，比 "- [ ]" 直观得多
    line = line.replace(/^(\s*)[-*+]\s+\[[xX]\]\s*/, '$1☑ ');
    line = line.replace(/^(\s*)[-*+]\s+\[\s\]\s*/, '$1☐ ');
    // 无序列表：• ；有序列表保留数字
    line = line.replace(/^(\s*)[-*+]\s+/, '$1• ');
    // 标题井号、引用符号
    line = line.replace(/^\s*#{1,6}\s+/, '');
    line = line.replace(/^\s*>\s?/, '');
    // 双链 [[路径|显示名]] → 显示名（没有 | 就取最后一段）
    line = line.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => {
      if (alias) return alias;
      const base = target.split('/').pop() ?? target;
      return base.replace(/\.(md|markdown)$/i, '');
    });
    // 普通链接 [文字](url) → 文字
    line = line.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    // 强调 / 删除线 / 高亮 / 行内代码：去记号留内容
    line = line.replace(/(\*\*|__)(.+?)\1/g, '$2');
    line = line.replace(/(\*|_)(?=\S)(.+?)(?<=\S)\1/g, '$2');
    line = line.replace(/~~(.+?)~~/g, '$1');
    line = line.replace(/==(.+?)==/g, '$1');
    line = line.replace(/`([^`]+)`/g, '$1');
    // HTML 标签
    line = line.replace(/<[^>]+>/g, '');
    // 分隔线整行去掉
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) line = '';
    out.push(line.replace(/\s+$/, ''));
  }
  // 连续空行压成一行，首尾空行去掉
  const collapsed = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1)}…`;
}

/**
 * Markdown 格式化命令（v0.3.4）：纯函数实现，桌面/移动双端共用，可单测。
 *
 * 设计：对「全文 + 选区」做不可变变换，返回新全文与新选区。
 * 行级操作（标题/列表/引用）按整行处理；内联操作（加粗/斜体/代码）包裹选区。
 */

export interface Sel {
  from: number;
  to: number;
}

export interface EditResult {
  text: string;
  sel: Sel;
}

/** 选区所覆盖的行范围（按行号） */
function lineRange(text: string, sel: Sel): { start: number; end: number } {
  const before = text.slice(0, sel.from);
  const start = before.lastIndexOf('\n') + 1;
  let end = text.indexOf('\n', sel.to);
  if (end === -1) end = text.length;
  return { start, end };
}

/** 内联包裹/解包：选区已有 marker 则去掉（toggle），否则加上 */
export function toggleInline(text: string, sel: Sel, marker: string): EditResult {
  const selected = text.slice(sel.from, sel.to);
  // 情况1：选区本身已被 marker 包裹 → 解包
  if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length >= marker.length * 2) {
    const inner = selected.slice(marker.length, selected.length - marker.length);
    const next = text.slice(0, sel.from) + inner + text.slice(sel.to);
    return { text: next, sel: { from: sel.from, to: sel.from + inner.length } };
  }
  // 情况2：选区外侧紧邻 marker → 解包（光标在词内时常见）
  const m = marker.length;
  if (
    sel.from >= m &&
    text.slice(sel.from - m, sel.from) === marker &&
    text.slice(sel.to, sel.to + m) === marker
  ) {
    const next = text.slice(0, sel.from - m) + selected + text.slice(sel.to + m);
    return { text: next, sel: { from: sel.from - m, to: sel.to - m } };
  }
  // 情况3：包裹
  const next = text.slice(0, sel.from) + marker + selected + marker + text.slice(sel.to);
  return { text: next, sel: { from: sel.from + m, to: sel.to + m } };
}

/** 行级前缀 toggle：所有覆盖行都有前缀 → 全部去掉；否则 → 全部加上 */
export function toggleLinePrefix(text: string, sel: Sel, prefix: string): EditResult {
  const { start, end } = lineRange(text, sel);
  const block = text.slice(start, end);
  const lines = block.split('\n');
  const allHave = lines.every((l) => l.startsWith(prefix) || l.trim() === '');
  const nextLines = allHave
    ? lines.map((l) => (l.startsWith(prefix) ? l.slice(prefix.length) : l))
    : lines.map((l) => (l.trim() === '' ? l : prefix + l.replace(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '')));
  const nextBlock = nextLines.join('\n');
  const next = text.slice(0, start) + nextBlock + text.slice(end);
  return { text: next, sel: { from: start, to: start + nextBlock.length } };
}

/** 标题级别循环：无 → # → ## → ### → 无 */
export function cycleHeading(text: string, sel: Sel): EditResult {
  const { start, end } = lineRange(text, sel);
  const lines = text.slice(start, end).split('\n');
  const nextLines = lines.map((l) => {
    const m = l.match(/^(#{1,3})\s+/);
    if (!m) return `# ${l}`;
    if (m[1].length >= 3) return l.replace(/^#{1,3}\s+/, '');
    return `#${l}`;
  });
  const nextBlock = nextLines.join('\n');
  const next = text.slice(0, start) + nextBlock + text.slice(end);
  return { text: next, sel: { from: start, to: start + nextBlock.length } };
}

/** 有序列表 toggle：1. 2. 3. 编号 */
export function toggleOrderedList(text: string, sel: Sel): EditResult {
  const { start, end } = lineRange(text, sel);
  const lines = text.slice(start, end).split('\n');
  const allHave = lines.every((l) => /^\d+\.\s/.test(l) || l.trim() === '');
  const nextLines = allHave
    ? lines.map((l) => l.replace(/^\d+\.\s/, ''))
    : lines.map((l, i) => (l.trim() === '' ? l : `${i + 1}. ${l.replace(/^\d+\.\s/, '')}`));
  const nextBlock = nextLines.join('\n');
  const next = text.slice(0, start) + nextBlock + text.slice(end);
  return { text: next, sel: { from: start, to: start + nextBlock.length } };
}

/** 任务列表 toggle：- [ ] */
export function toggleTaskList(text: string, sel: Sel): EditResult {
  const { start, end } = lineRange(text, sel);
  const lines = text.slice(start, end).split('\n');
  const allHave = lines.every((l) => /^-\s\[[ xX]\]\s/.test(l) || l.trim() === '');
  const nextLines = allHave
    ? lines.map((l) => l.replace(/^-\s\[[ xX]\]\s/, ''))
    : lines.map((l) => (l.trim() === '' ? l : `- [ ] ${l.replace(/^(-\s\[[ xX]\]\s|-\s)/, '')}`));
  const nextBlock = nextLines.join('\n');
  const next = text.slice(0, start) + nextBlock + text.slice(end);
  return { text: next, sel: { from: start, to: start + nextBlock.length } };
}

/** 链接：选区作为文字，光标停在 url 占位处 */
export function insertLink(text: string, sel: Sel): EditResult {
  const selected = text.slice(sel.from, sel.to) || '链接文字';
  const snippet = `[${selected}](https://)`;
  const next = text.slice(0, sel.from) + snippet + text.slice(sel.to);
  const urlStart = sel.from + selected.length + 3; // [text]( 之后
  return { text: next, sel: { from: urlStart, to: urlStart + 'https://'.length } };
}

/** 图片引用：在光标处插入 ![alt](path) */
/**
 * 插入图片引用。
 *
 * `relPath` 是**库内**路径（只拿来取 alt 文字），`href` 才是写进括号里的东西——
 * 它必须是**相对这篇笔记**的路径。v0.10.6 及以前两者是同一个值，于是子目录里的
 * 笔记全都写出了 Obsidian 解析不了的链接（见 `lib/attachPath.ts`）。
 */
export function insertImage(text: string, sel: Sel, relPath: string, href = relPath): EditResult {
  const snippet = `![${relPath.split('/').pop()!.replace(/\.[a-z0-9]+$/i, '')}](${href})`;
  const next = text.slice(0, sel.from) + snippet + text.slice(sel.to);
  const pos = sel.from + snippet.length;
  return { text: next, sel: { from: pos, to: pos } };
}

/**
 * 设置标题级别（v0.11.0，右键「段落设置」用）。
 *
 * 与 `cycleHeading` 的循环不同：这里是**指定**级别，`level=0` 表示恢复正文。
 * 工具栏按一下循环是快的，菜单里点「标题 3」却得到「标题 1」就是错的。
 */
export function setHeading(text: string, sel: Sel, level: number): EditResult {
  const { start, end } = lineRange(text, sel);
  const lines = text.slice(start, end).split('\n');
  const nextLines = lines.map((l) => {
    const body = l.replace(/^#{1,6}\s+/, '');
    return level > 0 ? `${'#'.repeat(level)} ${body}` : body;
  });
  const nextBlock = nextLines.join('\n');
  const next = text.slice(0, start) + nextBlock + text.slice(end);
  return { text: next, sel: { from: start, to: start + nextBlock.length } };
}

/**
 * 在光标处插入一段**块级**内容（表格 / 分隔线 / 代码块 / 标注）。
 *
 * 不在行首就先换行——把一个表格塞进一行文字中间，Markdown 不会把它当表格，
 * 用户看到的是一串竖线。插入后光标落在块的**第一个可编辑位置**（占位符处）。
 */
export function insertBlock(text: string, sel: Sel, block: string, caretOffset?: number): EditResult {
  const atLineStart = sel.from === 0 || text[sel.from - 1] === '\n';
  const lead = atLineStart ? '' : '\n';
  const snippet = `${lead}${block}`;
  const next = text.slice(0, sel.from) + snippet + text.slice(sel.to);
  const pos = sel.from + lead.length + (caretOffset ?? block.length);
  return { text: next, sel: { from: pos, to: pos } };
}

/** 在光标处插入一段纯文本（日期/时间这类），光标落到末尾 */
export function insertText(text: string, sel: Sel, snippet: string): EditResult {
  const next = text.slice(0, sel.from) + snippet + text.slice(sel.to);
  const pos = sel.from + snippet.length;
  return { text: next, sel: { from: pos, to: pos } };
}

/**
 * 清除选区里的行内格式（v0.11.0）。
 *
 * 只脱掉**成对**的标记与行首的块标记，链接保留文字丢掉地址。
 * 刻意不碰行内代码里的内容以外的东西——「清除格式」不该顺手改动正文语义。
 */
export function clearFormatting(text: string, sel: Sel): EditResult {
  const selected = text.slice(sel.from, sel.to);
  if (!selected) return { text, sel };
  const cleaned = selected
    .replace(/!\[([^\]\n]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/\[([^\]\n]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/==([^=\n]+)==/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/^\s*(#{1,6}\s+|>\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+)/gm, '');
  const next = text.slice(0, sel.from) + cleaned + text.slice(sel.to);
  return { text: next, sel: { from: sel.from, to: sel.from + cleaned.length } };
}

/**
 * 库内双链 `[[目标]]`（v0.11.0，右键「新增链接」）。
 *
 * 与 `insertLink`（外部链接 `[文字](https://)`）分开：Obsidian 的右键菜单里
 * 「新增链接」就是双链、「新增外部链接」才是 Markdown 链接，两者不该混成一个。
 * 有选区时把选中的文字当成目标，光标落在目标上，接着敲就能改（也会触发 [[ 补全）。
 */
export function insertWikiLink(text: string, sel: Sel): EditResult {
  const selected = text.slice(sel.from, sel.to);
  const snippet = `[[${selected}]]`;
  const next = text.slice(0, sel.from) + snippet + text.slice(sel.to);
  const inner = sel.from + 2;
  return { text: next, sel: { from: inner, to: inner + selected.length } };
}

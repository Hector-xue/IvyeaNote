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
export function insertImage(text: string, sel: Sel, relPath: string): EditResult {
  const snippet = `![${relPath.split('/').pop()!.replace(/\.[a-z0-9]+$/i, '')}](${relPath})`;
  const next = text.slice(0, sel.from) + snippet + text.slice(sel.to);
  const pos = sel.from + snippet.length;
  return { text: next, sel: { from: pos, to: pos } };
}

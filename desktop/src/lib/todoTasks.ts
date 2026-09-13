/**
 * 「待办」小部件的数据（v0.11.31）：从全库正文索引里把没完成的 `- [ ]` 捞出来，
 * 以及"在桌面上勾掉一条"落回 Markdown 的那一步。
 *
 * 纯函数，无 DOM。匹配规则与原生侧 TodoWriter.kt 的 toggleLine 一致——
 * App 没在跑时是原生改文件，两边判"是不是同一行"必须同一套，否则同一次点击
 * 在两条路上结果不一样。
 */
import { stripInline } from './widgetText';

export interface TodoTask {
  path: string;
  /** 所在笔记的标题 */
  title: string;
  /** 0 起的行号 */
  line: number;
  /** `- [ ]` 后面的 Markdown 原文（核对那一行用） */
  raw: string;
  /** 剥掉记号后给人看的 */
  text: string;
}

/** 小部件最多列多少条。4×4 也就十来行，再多只是把 SharedPreferences 撑大 */
export const TODO_MAX = 40;

/** 一条未完成的任务行：列表记号（- * + 或 1. / 1)）+ `[ ]` + 内容 */
const TASK_LINE = /^(\s*(?:[-*+]|\d+[.)])\s+)\[ \]\s+(.*?)\s*$/;

/** 一篇笔记里所有未完成的任务（按行号） */
export function tasksOf(path: string, title: string, content: string): TodoTask[] {
  const out: TodoTask[] = [];
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // 代码块里的 "- [ ]" 不是待办
    if (/^\s*(```|~~~)/.test(l)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const m = TASK_LINE.exec(l);
    if (!m) continue;
    const raw = m[2];
    if (!raw) continue;
    out.push({ path, title, line: i, raw, text: stripInline(raw).trim() || raw });
  }
  return out;
}

/**
 * 整个库的待办列表：按笔记修改时间新的在前（最近在写的事项最要紧），同一篇按行号。
 * `docs` 是全文索引，`mtimeOf` 给排序用。
 */
export function collectTasks(
  docs: readonly { path: string; content: string }[],
  mtimeOf: (path: string) => number,
  titleOf: (path: string) => string,
  max = TODO_MAX
): TodoTask[] {
  const sorted = [...docs].sort((a, b) => mtimeOf(b.path) - mtimeOf(a.path) || a.path.localeCompare(b.path));
  const out: TodoTask[] = [];
  for (const d of sorted) {
    if (!/\.(md|markdown)$/i.test(d.path)) continue;
    if (d.path.startsWith('.trash/') || d.path.startsWith('.ivyea/')) continue;
    for (const t of tasksOf(d.path, titleOf(d.path), d.content)) {
      out.push(t);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/**
 * 把第 `line` 行的未完成事项标成完成。那一行对不上（同步 / 别处已经改过）就在全文里
 * 找**唯一**一条同原文的未完成事项；找不到或不唯一返回 null——宁可不改也不能改错行。
 * 保留原有换行风格（CRLF / LF）。
 */
export function toggleTaskLine(content: string, line: number, raw: string): string | null {
  const crlf = content.includes('\r\n');
  const lines = content.split('\n').map((l) => l.replace(/\r$/, ''));
  const matches = (i: number) => {
    const m = TASK_LINE.exec(lines[i]);
    return !!m && m[2] === raw;
  };
  let idx = -1;
  if (line >= 0 && line < lines.length && matches(line)) {
    idx = line;
  } else {
    const hits: number[] = [];
    for (let i = 0; i < lines.length; i++) if (matches(i)) hits.push(i);
    if (hits.length === 1) idx = hits[0];
  }
  if (idx < 0) return null;
  lines[idx] = lines[idx].replace('[ ]', '[x]');
  return lines.join(crlf ? '\r\n' : '\n');
}

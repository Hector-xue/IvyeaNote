/**
 * Markdown（GFM）表格的解析、序列化与结构操作（v0.11.34）。纯函数，可单测。
 *
 * 为什么有这个文件：编辑态的表格此前只是"等宽字体 + `|---|` 淡出"的一行行文本，
 * 用户的原话是「插入表格功能太拉了吧，我还以为是像正常表格一样」。
 * 要把它做成真正的表格（单元格里打字、Tab 换格、右键增删行列），
 * 所有对文档的改动都得落回 Markdown 源码——这里就是那套"源码 ⇄ 表格模型"的规则。
 *
 * 行号约定：模型里 `rows` 只放正文行；源码里第 0 行是表头、第 1 行是分隔行、
 * 第 2 行起是正文，所以「第 r 个正文行」对应源码第 `r + 2` 行。
 * 单元格文本存的是**未转义**的内容（`\|` 已还原成 `|`），序列化时再转回去。
 */

export type Align = 'left' | 'center' | 'right' | null;

export interface TableModel {
  header: string[];
  align: Align[];
  rows: string[][];
}

/** 一行文本是不是"像"表格的一行：非空且含有竖线（GFM 的正文行不要求首尾竖线） */
export function looksLikeRow(line: string): boolean {
  return line.trim() !== '' && line.includes('|');
}

/**
 * 把一行拆成单元格。首尾的竖线是可选的；`\|` 不是分隔符，还原成 `|`。
 * 行内代码里的竖线按 GFM 的规矩**同样**要转义，所以这里不用管反引号。
 */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

/** 分隔行：每格形如 `---` / `:---` / `---:` / `:---:`（至少一个 -） */
export function isDividerRow(line: string): boolean {
  if (!looksLikeRow(line)) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

export function parseAlign(cell: string): Align {
  const l = cell.startsWith(':');
  const r = cell.endsWith(':');
  if (l && r) return 'center';
  if (r) return 'right';
  if (l) return 'left';
  return null;
}

/**
 * 从若干行源码解析成模型。第 0 行是表头，第 1 行必须是分隔行且格数与表头一致
 * （GFM 的硬规定；格数不一致的"表格"在 GitHub 上也只是一段文字）。
 * 正文行多出来的格丢掉、缺的补空——与 GFM 一致。
 */
export function parseTable(lines: readonly string[]): TableModel | null {
  if (lines.length < 2) return null;
  if (!looksLikeRow(lines[0]) || !isDividerRow(lines[1])) return null;
  const header = splitRow(lines[0]);
  const div = splitRow(lines[1]);
  if (div.length !== header.length) return null;
  const n = header.length;
  const align = div.map(parseAlign);
  const rows = lines.slice(2).map((l) => {
    const cells = splitRow(l).slice(0, n);
    while (cells.length < n) cells.push('');
    return cells;
  });
  return { header, align, rows };
}

export function escapeCell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function dividerCell(a: Align): string {
  switch (a) {
    case 'center':
      return ':---:';
    case 'right':
      return '---:';
    case 'left':
      return ':---';
    default:
      return '---';
  }
}

export function serializeRow(cells: readonly string[]): string {
  return `| ${cells.map(escapeCell).join(' | ')} |`;
}

/** 整张表序列化成源码行（不含末尾换行） */
export function serializeTable(m: TableModel): string[] {
  return [serializeRow(m.header), `| ${m.align.map(dividerCell).join(' | ')} |`, ...m.rows.map(serializeRow)];
}

/**
 * 只改一格、只重写那一行：其余行原样保留，用户手工对齐过的源码不会被整张重排。
 * `rowLine` 是那一行的源码；格数不足时补到 `cols`。
 */
export function setCellInRow(rowLine: string, col: number, text: string, cols: number): string {
  const cells = splitRow(rowLine).slice(0, cols);
  while (cells.length < cols) cells.push('');
  cells[col] = text;
  return serializeRow(cells);
}

/**
 * 扫出整篇里所有表格的行号区间（1 起、含首尾）。
 * 表格从「表头 + 分隔行」开始，往下延伸到第一个空行或不含竖线的行为止（GFM 规则）。
 * `skip` 是不参与的行号（代码块里的东西）。
 */
export function scanTables(
  lines: Iterable<string>,
  skip: ReadonlyMap<number, unknown> = new Map()
): { start: number; end: number }[] {
  const arr = [...lines];
  const out: { start: number; end: number }[] = [];
  let i = 0;
  while (i < arr.length) {
    const n = i + 1;
    if (!skip.has(n) && !skip.has(n + 1) && i + 1 < arr.length && parseTable([arr[i], arr[i + 1]])) {
      let end = i + 1;
      while (end + 1 < arr.length && !skip.has(end + 2) && looksLikeRow(arr[end + 1])) end++;
      out.push({ start: n, end: end + 1 });
      i = end + 1;
      continue;
    }
    i++;
  }
  return out;
}

/* ---------------- 结构操作：都返回新模型，不改入参 ---------------- */

const clone = (m: TableModel): TableModel => ({
  header: [...m.header],
  align: [...m.align],
  rows: m.rows.map((r) => [...r]),
});

/** 在正文第 `at` 行之前插入一空行（`at === rows.length` 即追加到末尾） */
export function insertRow(m: TableModel, at: number): TableModel {
  const n = clone(m);
  const idx = Math.max(0, Math.min(at, n.rows.length));
  n.rows.splice(idx, 0, n.header.map(() => ''));
  return n;
}

/** 删掉正文第 `idx` 行。表头不能删（要删整张表） */
export function deleteRow(m: TableModel, idx: number): TableModel {
  const n = clone(m);
  if (idx >= 0 && idx < n.rows.length) n.rows.splice(idx, 1);
  return n;
}

/** 在第 `at` 列之前插入一空列 */
export function insertCol(m: TableModel, at: number): TableModel {
  const n = clone(m);
  const idx = Math.max(0, Math.min(at, n.header.length));
  n.header.splice(idx, 0, '');
  n.align.splice(idx, 0, null);
  for (const r of n.rows) r.splice(idx, 0, '');
  return n;
}

/** 删掉第 `idx` 列。只剩一列时不删（返回 null，让调用方去删整张表） */
export function deleteCol(m: TableModel, idx: number): TableModel | null {
  if (m.header.length <= 1 || idx < 0 || idx >= m.header.length) return null;
  const n = clone(m);
  n.header.splice(idx, 1);
  n.align.splice(idx, 1);
  for (const r of n.rows) r.splice(idx, 1);
  return n;
}

export function setAlign(m: TableModel, col: number, align: Align): TableModel {
  const n = clone(m);
  if (col >= 0 && col < n.align.length) n.align[col] = align;
  return n;
}

/** 把正文第 `idx` 行往上/下挪一格 */
export function moveRow(m: TableModel, idx: number, dir: -1 | 1): TableModel {
  const n = clone(m);
  const j = idx + dir;
  if (idx < 0 || idx >= n.rows.length || j < 0 || j >= n.rows.length) return n;
  [n.rows[idx], n.rows[j]] = [n.rows[j], n.rows[idx]];
  return n;
}

/** 把第 `idx` 列往左/右挪一格（表头、对齐、正文一起动） */
export function moveCol(m: TableModel, idx: number, dir: -1 | 1): TableModel {
  const n = clone(m);
  const j = idx + dir;
  if (idx < 0 || idx >= n.header.length || j < 0 || j >= n.header.length) return n;
  const swap = (arr: unknown[]) => {
    [arr[idx], arr[j]] = [arr[j], arr[idx]];
  };
  swap(n.header);
  swap(n.align);
  n.rows.forEach(swap);
  return n;
}

/** 「插入表格」的初始源码：两列一行正文，光标该落在第一个表头格 */
export function emptyTable(cols = 2, rows = 1): string[] {
  const header = Array.from({ length: cols }, (_, i) => `列 ${i + 1}`);
  return serializeTable({
    header,
    align: header.map(() => null),
    rows: Array.from({ length: rows }, () => header.map(() => '')),
  });
}

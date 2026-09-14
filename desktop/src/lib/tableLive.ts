/**
 * 编辑态的**真表格**（v0.11.34）。
 *
 * 此前 Live Preview 里的表格只是"等宽字体 + 分隔行淡出"的一行行 `|` 文本，
 * 用户的原话是「插入表格功能太拉了吧，我还以为是像正常表格一样，现在的表格也太垃圾了吧」。
 * 现在整张表换成一个块级 widget：真正的 `<table>`，每格可以直接打字，
 * Tab / Enter 在格子间移动，右键增删行列、设对齐。改动即时落回 Markdown 源码——
 * 文档里存的永远是标准 GFM 表格，换 Obsidian / GitHub 打开一模一样。
 *
 * 几条结构性的决定，改之前先读：
 * - **必须是 StateField 不能是 ViewPlugin**：CodeMirror 规定"以函数形式提供的装饰
 *   （ViewPlugin 就是）不得引入块级 widget 或跨行的 replace"，会破坏竖向布局计算。
 *   livePreview.ts 里那套行内装饰是 ViewPlugin，所以表格单独在这里。
 * - **同一张表的 DOM 要复用**（`updateDOM`）：每敲一个字都会改文档 → 重建装饰 →
 *   新的 widget 实例。若每次都重新 `toDOM`，正在打字的那格会失焦。这里只补丁
 *   变了的格子，正在编辑的那格连内容都不碰（它已经是最新的）。
 * - **事件全部由 widget 自己处理**（`ignoreEvent` 返回 true）：格子里的键盘、鼠标、
 *   选区变化都不能交给 CodeMirror，否则它会试图把 DOM 选区映射回文档位置、
 *   把格子里的输入当成对隐藏行的编辑。
 * - 单元格里显示的是**渲染后的行内 Markdown**（加粗 / 代码 / 链接），聚焦那一格时
 *   切回源码——与 Obsidian 一致。渲染走 marked + DOMPurify，和阅读态同一套。
 */
import { Annotation, EditorState, Facet, Prec, StateField } from '@codemirror/state';
import { Decoration, EditorView, keymap, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { scanFences } from './livePreview';
import {
  deleteCol,
  deleteRow,
  insertCol,
  insertRow,
  looksLikeRow,
  moveCol,
  moveRow,
  parseTable,
  scanTables,
  serializeTable,
  setAlign,
  setCellInRow,
  type Align,
  type TableModel,
} from './tableEdit';

/** 由表格 widget 发起的文档改动都带这个标注（目前只用于调试 / 测试辨认） */
export const TableEdit = Annotation.define<boolean>();

/** 格子里的链接被点了：交给外面（与 livePreview 的 .cm-live-link 同一条路） */
export const tableLinkOpener = Facet.define<(href: string) => void, ((href: string) => void) | null>({
  combine: (v) => v[0] ?? null,
});

/** 表格里的一个位置。`from` 是这张表在文档里的起点，`row` 0 = 表头、≥1 = 第 row 个正文行 */
export interface TableCellRef {
  from: number;
  row: number;
  col: number;
}

/** 一张表在当前文档里的完整信息 */
export interface TableAt {
  from: number;
  to: number;
  /** 表头那一行的行号（1 起） */
  startLine: number;
  lines: string[];
  model: TableModel;
}

/** 从表格起点（表头行开头）读出整张表。起点不是表头就返回 null */
export function tableAt(state: EditorState, from: number): TableAt | null {
  if (from < 0 || from > state.doc.length) return null;
  const first = state.doc.lineAt(from);
  if (first.from !== from) return null;
  const lines: string[] = [];
  let n = first.number;
  while (n <= state.doc.lines) {
    const l = state.doc.line(n);
    if (!looksLikeRow(l.text)) break;
    lines.push(l.text);
    n++;
  }
  const model = parseTable(lines);
  if (!model) return null;
  const last = state.doc.line(first.number + lines.length - 1);
  return { from, to: last.to, startLine: first.number, lines, model };
}

/** 模型行号 → 源码行索引（表头 0、分隔 1、正文从 2 起） */
const lineIndexOf = (row: number) => (row === 0 ? 0 : row + 1);

/** 行内 Markdown → 安全的 HTML（与阅读态同一套 marked 配置） */
function renderInline(src: string): string {
  if (src === '') return '';
  try {
    return DOMPurify.sanitize(marked.parseInline(src, { async: false }) as string);
  } catch {
    return DOMPurify.sanitize(src);
  }
}

/** 想聚焦哪一格：结构操作 / 插入表格之后由调用方登记，widget 画完就去聚焦 */
const pendingFocus = new WeakMap<EditorView, TableCellRef & { caret?: Caret }>();

function cellOf(dom: HTMLElement, row: number, col: number): HTMLTableCellElement | null {
  return dom.querySelector<HTMLTableCellElement>(`[data-r="${row}"][data-c="${col}"]`);
}

export type Caret = 'start' | 'end' | 'all';

/** 光标放到这一格的开头 / 末尾，或整格选中（占位文字一打字就被换掉） */
function placeCaret(cell: HTMLElement, where: Caret) {
  const sel = cell.ownerDocument.getSelection();
  if (!sel) return;
  const range = cell.ownerDocument.createRange();
  range.selectNodeContents(cell);
  if (where !== 'all') range.collapse(where === 'start');
  sel.removeAllRanges();
  sel.addRange(range);
}

/** 让这一格进入编辑：源码显形、聚焦、光标落到指定端 */
function focusCell(cell: HTMLTableCellElement, where: Caret = 'end') {
  cell.focus();
  placeCaret(cell, where);
}

/**
 * 找到 `from` 处那张表的 DOM 并聚焦某一格。dispatch 之后 DOM 已同步更新，
 * 直接查就行；查不到（还没进视口）就算了，不抛。
 */
export function focusTableCell(view: EditorView, ref: TableCellRef & { caret?: Caret }): boolean {
  for (const el of view.contentDOM.querySelectorAll<HTMLElement>('.cm-live-tbl')) {
    if (view.posAtDOM(el) !== ref.from) continue;
    const cell = cellOf(el, ref.row, ref.col);
    if (!cell) return false;
    focusCell(cell, ref.caret ?? 'end');
    return true;
  }
  // 还没画出来：登记下来，widget 画完再来
  pendingFocus.set(view, ref);
  return false;
}

/** 单元格是否可编辑：只读状态（右栏只读预览）不可 */
function editableValue(view: EditorView): string {
  return view.state.readOnly ? 'false' : 'plaintext-only';
}

function applyEditable(cell: HTMLElement, value: string) {
  try {
    cell.contentEditable = value;
    // 老 Firefox 不认 plaintext-only：退回普通 contenteditable（粘贴由 paste 处理器兜着）
    if (value === 'plaintext-only' && cell.contentEditable !== 'plaintext-only') cell.contentEditable = 'true';
  } catch {
    cell.contentEditable = value === 'false' ? 'false' : 'true';
  }
}

function alignStyle(a: Align): string {
  return a ?? '';
}

/** 画一格的**非编辑态**内容（渲染后的行内 Markdown） */
function paintCell(cell: HTMLTableCellElement, src: string) {
  cell.dataset.src = src;
  cell.innerHTML = renderInline(src);
  for (const a of cell.querySelectorAll('a')) {
    const href = a.getAttribute('href') ?? '';
    a.setAttribute('data-href', href);
    a.classList.add('cm-live-link');
  }
}

function buildTable(dom: HTMLElement, model: TableModel, view: EditorView) {
  const editable = editableValue(view);
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  model.header.forEach((h, c) => {
    const th = document.createElement('th');
    th.dataset.r = '0';
    th.dataset.c = String(c);
    th.style.textAlign = alignStyle(model.align[c]);
    applyEditable(th, editable);
    paintCell(th, h);
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  const tbody = document.createElement('tbody');
  model.rows.forEach((row, r) => {
    const tr = document.createElement('tr');
    row.forEach((v, c) => {
      const td = document.createElement('td');
      td.dataset.r = String(r + 1);
      td.dataset.c = String(c);
      td.style.textAlign = alignStyle(model.align[c]);
      applyEditable(td, editable);
      paintCell(td, v);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(thead);
  table.appendChild(tbody);
  dom.replaceChildren(table);
  dom.dataset.rows = String(model.rows.length);
  dom.dataset.cols = String(model.header.length);
}

/**
 * 同一张表、新内容：只补丁变了的格。正在编辑的那格（activeElement）内容不动——
 * 它就是这次改动的来源，动它会把光标打飞。
 */
function patchTable(dom: HTMLElement, model: TableModel, view: EditorView): boolean {
  const sameShape =
    dom.dataset.rows === String(model.rows.length) && dom.dataset.cols === String(model.header.length);
  if (!sameShape) {
    buildTable(dom, model, view);
    return true;
  }
  const active = dom.ownerDocument.activeElement;
  const visit = (row: number, cells: readonly string[]) => {
    cells.forEach((src, c) => {
      const cell = cellOf(dom, row, c);
      if (!cell) return;
      const a = model.align[c] ?? '';
      if (cell.style.textAlign !== a) cell.style.textAlign = a;
      if (cell.dataset.src === src) return;
      if (cell === active) {
        cell.dataset.src = src;
        // 内容通常已经是最新的（这次改动就是它打出来的）；不是的话（别处改了文档，
        // 比如同步拉回来）就把源码灌进去，光标放到末尾
        if (cell.textContent !== src) {
          cell.textContent = src;
          placeCaret(cell, 'end');
        }
        return;
      }
      paintCell(cell, src);
    });
  };
  visit(0, model.header);
  model.rows.forEach((r, i) => visit(i + 1, r));
  return true;
}

class TableWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly model: TableModel
  ) {
    super();
  }
  override eq(other: TableWidget) {
    return other.src === this.src;
  }
  override toDOM(view: EditorView) {
    const dom = document.createElement('div');
    dom.className = 'cm-live-tbl';
    buildTable(dom, this.model, view);
    attachHandlers(dom, view);
    this.afterPaint(dom, view);
    return dom;
  }
  override updateDOM(dom: HTMLElement, view: EditorView) {
    patchTable(dom, this.model, view);
    this.afterPaint(dom, view);
    return true;
  }
  /** 有人登记了"画完聚焦这格"：现在 DOM 齐了，去聚焦 */
  private afterPaint(dom: HTMLElement, view: EditorView) {
    const want = pendingFocus.get(view);
    if (!want) return;
    queueMicrotask(() => {
      if (pendingFocus.get(view) !== want) return;
      if (view.posAtDOM(dom) !== want.from) return;
      const cell = cellOf(dom, want.row, want.col);
      if (!cell) return;
      pendingFocus.delete(view);
      focusCell(cell, want.caret ?? 'end');
    });
  }
  override ignoreEvent() {
    return true;
  }
  override get estimatedHeight() {
    return (this.model.rows.length + 1) * 36 + 12;
  }
}

/* ------------------------------------------------------------------ */
/* 交互                                                                */
/* ------------------------------------------------------------------ */

function cellFromEvent(dom: HTMLElement, e: Event): HTMLTableCellElement | null {
  const t = e.target as HTMLElement | null;
  const cell = t?.closest?.('td,th') as HTMLTableCellElement | null;
  return cell && dom.contains(cell) ? cell : null;
}

function refOf(dom: HTMLElement, cell: HTMLTableCellElement, view: EditorView): TableCellRef {
  return { from: view.posAtDOM(dom), row: Number(cell.dataset.r), col: Number(cell.dataset.c) };
}

/** 一格的文本写回源码：只重写那一行 */
function commitCell(view: EditorView, ref: TableCellRef, text: string) {
  const t = tableAt(view.state, ref.from);
  if (!t) return;
  const li = lineIndexOf(ref.row);
  if (li >= t.lines.length) return;
  const line = view.state.doc.line(t.startLine + li);
  const next = setCellInRow(line.text, ref.col, text, t.model.header.length);
  if (next === line.text) return;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: next },
    annotations: TableEdit.of(true),
  });
}

/** 整张表按新模型重写（结构操作用） */
function commitModel(view: EditorView, from: number, model: TableModel): boolean {
  const t = tableAt(view.state, from);
  if (!t) return false;
  view.dispatch({
    changes: { from: t.from, to: t.to, insert: serializeTable(model).join('\n') },
    annotations: TableEdit.of(true),
  });
  return true;
}

/** 在格子里插入纯文本（粘贴 / Shift+Enter 的 <br>） */
function insertPlain(text: string) {
  document.execCommand('insertText', false, text);
}

/** 光标是否在这一格文本的最前 / 最后（左右方向键跨格用） */
function caretAt(cell: HTMLElement): 'start' | 'end' | 'mid' | null {
  const sel = cell.ownerDocument.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  const pre = r.cloneRange();
  pre.selectNodeContents(cell);
  pre.setEnd(r.startContainer, r.startOffset);
  const before = pre.toString().length;
  const total = (cell.textContent ?? '').length;
  if (before === 0 && total === 0) return 'start';
  if (before === 0) return 'start';
  if (before >= total) return 'end';
  return 'mid';
}

/** 离开表格、把 CodeMirror 的光标放到表格前 / 后那一行 */
function leaveTable(view: EditorView, from: number, dir: -1 | 1) {
  const t = tableAt(view.state, from);
  if (!t) return;
  let pos: number;
  if (dir < 0) {
    if (t.from === 0) {
      // 表格就在文首：前面没有行，插一个空行让光标有地方去
      view.dispatch({ changes: { from: 0, insert: '\n' }, selection: { anchor: 0 } });
      view.focus();
      return;
    }
    pos = view.state.doc.lineAt(t.from - 1).to;
  } else {
    if (t.to >= view.state.doc.length) {
      view.dispatch({ changes: { from: t.to, insert: '\n' }, selection: { anchor: t.to + 1 } });
      view.focus();
      return;
    }
    pos = t.to + 1;
  }
  (view.dom.ownerDocument.activeElement as HTMLElement | null)?.blur?.();
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  view.focus();
}

function attachHandlers(dom: HTMLElement, view: EditorView) {
  // 聚焦：这一格显示源码
  dom.addEventListener('focusin', (e) => {
    const cell = cellFromEvent(dom, e);
    if (!cell) return;
    if (cell.textContent !== cell.dataset.src || cell.children.length > 0) {
      cell.textContent = cell.dataset.src ?? '';
    }
    cell.classList.add('editing');
  });
  // 失焦：回到渲染态
  dom.addEventListener('focusout', (e) => {
    const cell = cellFromEvent(dom, e);
    if (!cell) return;
    cell.classList.remove('editing');
    paintCell(cell, cell.dataset.src ?? '');
  });
  // 输入：写回源码（每一击都写，撤销栈由 CodeMirror 的 history 接管）
  dom.addEventListener('input', (e) => {
    const cell = cellFromEvent(dom, e);
    if (!cell) return;
    // contenteditable 清空后浏览器会留一个 <br>；textContent 会把它忽略掉，正好
    const text = (cell.textContent ?? '').replace(/\u00a0/g, ' ');
    cell.dataset.src = text;
    commitCell(view, refOf(dom, cell, view), text);
  });
  dom.addEventListener('paste', (e) => {
    const cell = cellFromEvent(dom, e);
    if (!cell) return;
    e.preventDefault();
    const text = (e.clipboardData?.getData('text/plain') ?? '').replace(/\r?\n/g, ' ');
    if (text) insertPlain(text);
  });
  // 链接：格子里点链接要跳，不能让 WebView 带着整个应用导航走
  dom.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement | null)?.closest?.('a[data-href]') as HTMLElement | null;
    if (!a || !dom.contains(a)) return;
    e.preventDefault();
    const cell = a.closest('td,th') as HTMLElement | null;
    if (cell?.classList.contains('editing')) return;
    view.state.facet(tableLinkOpener)?.(a.dataset.href ?? '');
  });
  dom.addEventListener('keydown', (e) => {
    const cell = cellFromEvent(dom, e);
    if (!cell || cell.contentEditable === 'false') return;
    const ref = refOf(dom, cell, view);
    const rows = Number(dom.dataset.rows);
    const cols = Number(dom.dataset.cols);
    const go = (row: number, col: number, caret: Caret = 'end') => {
      const target = cellOf(dom, row, col);
      if (target) focusCell(target, caret);
    };
    const mod = e.ctrlKey || e.metaKey;

    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) {
        if (ref.col > 0) go(ref.row, ref.col - 1);
        else if (ref.row > 0) go(ref.row - 1, cols - 1);
        return;
      }
      if (ref.col < cols - 1) go(ref.row, ref.col + 1);
      else if (ref.row < rows) go(ref.row + 1, 0);
      else {
        // 最后一格再 Tab：加一行（Obsidian / Notion 同款）
        const t = tableAt(view.state, ref.from);
        if (!t) return;
        if (commitModel(view, ref.from, insertRow(t.model, t.model.rows.length))) {
          focusTableCell(view, { from: ref.from, row: rows + 1, col: 0 });
        }
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        insertPlain('<br>');
        return;
      }
      if (ref.row < rows) go(ref.row + 1, ref.col);
      else {
        const t = tableAt(view.state, ref.from);
        if (!t) return;
        if (commitModel(view, ref.from, insertRow(t.model, t.model.rows.length))) {
          focusTableCell(view, { from: ref.from, row: rows + 1, col: ref.col });
        }
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      leaveTable(view, ref.from, 1);
      return;
    }
    if (e.key === 'ArrowUp' && !e.shiftKey) {
      e.preventDefault();
      if (ref.row > 0) go(ref.row - 1, ref.col);
      else leaveTable(view, ref.from, -1);
      return;
    }
    if (e.key === 'ArrowDown' && !e.shiftKey) {
      e.preventDefault();
      if (ref.row < rows) go(ref.row + 1, ref.col);
      else leaveTable(view, ref.from, 1);
      return;
    }
    if (e.key === 'ArrowLeft' && !e.shiftKey && caretAt(cell) === 'start') {
      if (ref.col > 0) {
        e.preventDefault();
        go(ref.row, ref.col - 1, 'end');
      } else if (ref.row > 0) {
        e.preventDefault();
        go(ref.row - 1, cols - 1, 'end');
      }
      return;
    }
    if (e.key === 'ArrowRight' && !e.shiftKey && caretAt(cell) === 'end') {
      if (ref.col < cols - 1) {
        e.preventDefault();
        go(ref.row, ref.col + 1, 'start');
      } else if (ref.row < rows) {
        e.preventDefault();
        go(ref.row + 1, 0, 'start');
      }
      return;
    }
    // 加粗 / 斜体：只包住格内的选区
    if (mod && (e.key === 'b' || e.key === 'i') && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      const sel = cell.ownerDocument.getSelection();
      const selected = sel && !sel.isCollapsed ? sel.toString() : '';
      const mark = e.key === 'b' ? '**' : '*';
      insertPlain(`${mark}${selected}${mark}`);
      return;
    }
  });
}

/* ------------------------------------------------------------------ */
/* 装饰：整篇扫表，每张换成一个块级 widget                              */
/* ------------------------------------------------------------------ */

function buildDecorations(state: EditorState): DecorationSet {
  const lines = [...state.doc.iterLines()];
  const fences = scanFences(lines);
  const ranges = [];
  for (const { start, end } of scanTables(lines, fences)) {
    const first = state.doc.line(start);
    const last = state.doc.line(end);
    const src = state.doc.sliceString(first.from, last.to);
    const model = parseTable(lines.slice(start - 1, end));
    if (!model) continue;
    ranges.push(Decoration.replace({ widget: new TableWidget(src, model), block: true }).range(first.from, last.to));
  }
  return Decoration.set(ranges, true);
}

export const tableField = StateField.define<DecorationSet>({
  create: buildDecorations,
  update(deco, tr) {
    return tr.docChanged ? buildDecorations(tr.state) : deco;
  },
  provide: (f) => [EditorView.decorations.from(f), EditorView.atomicRanges.of((v) => v.state.field(f))],
});

/**
 * 光标所在位置有没有紧邻的表格。`edge` 为真时要求 `pos` 正好在前一行末 / 后一行首
 * （→ ← Delete Backspace 用），否则光标在那一行任何位置都算（↑ ↓ 用）。
 */
function tableAfter(state: EditorState, pos: number, edge: boolean): TableAt | null {
  const line = state.doc.lineAt(pos);
  if ((edge && pos !== line.to) || line.number >= state.doc.lines) return null;
  return tableAt(state, state.doc.line(line.number + 1).from);
}
function tableBefore(state: EditorState, pos: number, edge: boolean): TableAt | null {
  const line = state.doc.lineAt(pos);
  if ((edge && pos !== line.from) || line.number <= 1) return null;
  // 上一行是某张表的最后一行：往上找到表头
  let n = line.number - 1;
  if (!looksLikeRow(state.doc.line(n).text)) return null;
  while (n > 1 && looksLikeRow(state.doc.line(n - 1).text)) n--;
  const t = tableAt(state, state.doc.line(n).from);
  return t && t.to === line.from - 1 ? t : null;
}

/**
 * 从正文用键盘进表：光标在表格前一行按 ↓ / 在后一行按 ↑ / 在前一行末按 →、
 * 在后一行首按 ← 或 Backspace，都进到相邻那一格，而不是让光标消失在隐藏行里。
 * Backspace 那条尤其要拦：atomicRanges 只挡"删进范围内"，光标在表后一行首时
 * 退格会把换行删掉、把下一行的字接到表格最后一行上，表就散了。
 */
export const tableKeymap = Prec.high(
  keymap.of([
    {
      key: 'ArrowDown',
      run: (view) => {
        const { main } = view.state.selection;
        if (!main.empty) return false;
        const t = tableAfter(view.state, main.head, false);
        if (!t) return false;
        return focusTableCell(view, { from: t.from, row: 0, col: 0, caret: 'start' });
      },
    },
    {
      key: 'ArrowRight',
      run: (view) => {
        const { main } = view.state.selection;
        if (!main.empty) return false;
        const t = tableAfter(view.state, main.head, true);
        if (!t) return false;
        return focusTableCell(view, { from: t.from, row: 0, col: 0, caret: 'start' });
      },
    },
    {
      key: 'ArrowUp',
      run: (view) => {
        const { main } = view.state.selection;
        if (!main.empty) return false;
        const t = tableBefore(view.state, main.head, false);
        if (!t) return false;
        return focusTableCell(view, { from: t.from, row: t.model.rows.length, col: 0, caret: 'end' });
      },
    },
    {
      key: 'ArrowLeft',
      run: (view) => {
        const { main } = view.state.selection;
        if (!main.empty) return false;
        const t = tableBefore(view.state, main.head, true);
        if (!t) return false;
        return focusTableCell(view, {
          from: t.from,
          row: t.model.rows.length,
          col: t.model.header.length - 1,
          caret: 'end',
        });
      },
    },
    {
      key: 'Backspace',
      run: (view) => {
        const { main } = view.state.selection;
        if (!main.empty) return false;
        const t = tableBefore(view.state, main.head, true);
        if (!t) return false;
        return focusTableCell(view, {
          from: t.from,
          row: t.model.rows.length,
          col: t.model.header.length - 1,
          caret: 'end',
        });
      },
    },
    {
      key: 'Delete',
      run: (view) => {
        const { main } = view.state.selection;
        if (!main.empty) return false;
        const t = tableAfter(view.state, main.head, true);
        if (!t) return false;
        return focusTableCell(view, { from: t.from, row: 0, col: 0, caret: 'start' });
      },
    },
  ])
);

/**
 * 光标掉进表格里时把焦点接到对应的格子。
 *
 * 表格是 replace 出来的原子块，CodeMirror 的光标在里面没有像素位置——
 * 手写 `| a | b |` 再敲出分隔行的那一刻整张表变成 widget，光标就"消失"了；
 * 撤销 / 粘贴 / 跳转到行同样会把光标落进去。这里按光标所在的行与它前面有几根
 * 竖线，算出该聚焦哪一格。widget 自己发起的改动（TableEdit 标注）不管：那时焦点
 * 本来就在格子里。
 */
const tableCursorGuard = ViewPlugin.fromClass(
  class {
    update(u: ViewUpdate) {
      if (!u.selectionSet && !u.docChanged) return;
      if (u.transactions.some((tr) => tr.annotation(TableEdit))) return;
      const { main } = u.state.selection;
      if (!main.empty) return;
      const view = u.view;
      if (!view.hasFocus) return;
      const deco = u.state.field(tableField, false);
      if (!deco) return;
      let hit: { from: number; to: number } | null = null;
      deco.between(main.head, main.head, (from, to) => {
        if (main.head >= from && main.head <= to) hit = { from, to };
        return false;
      });
      if (!hit) return;
      const { from } = hit;
      const line = u.state.doc.lineAt(main.head);
      const first = u.state.doc.lineAt(from);
      const li = line.number - first.number;
      const row = li <= 1 ? 0 : li - 1;
      const before = line.text.slice(0, main.head - line.from);
      const pipes = (before.match(/(?<!\\)\|/g) ?? []).length;
      const col = Math.max(0, pipes - (before.trimStart().startsWith('|') ? 1 : 0));
      queueMicrotask(() => {
        // 这一拍里已经有人把焦点放进格子了（比如「插入表格」选中表头占位）：别抢
        if (!view.hasFocus) return;
        const t = tableAt(view.state, from);
        if (!t) return;
        focusTableCell(view, {
          from,
          row: Math.min(row, t.model.rows.length),
          col: Math.min(col, t.model.header.length - 1),
          caret: 'end',
        });
      });
    }
  }
);

/** 编辑态表格的全部扩展 */
export const liveTables = [tableField, tableKeymap, tableCursorGuard];

/* ------------------------------------------------------------------ */
/* 结构操作：右键菜单调用                                              */
/* ------------------------------------------------------------------ */

export type TableOp =
  | 'row-above'
  | 'row-below'
  | 'row-delete'
  | 'row-up'
  | 'row-down'
  | 'col-left'
  | 'col-right'
  | 'col-delete'
  | 'col-moveleft'
  | 'col-moveright'
  | 'align-left'
  | 'align-center'
  | 'align-right'
  | 'align-none'
  | 'table-delete';

/** 右键菜单里那些结构操作。`ref` 是被右键的那一格。返回是否做了 */
export function runTableOp(view: EditorView, ref: TableCellRef, op: TableOp): boolean {
  const t = tableAt(view.state, ref.from);
  if (!t) return false;
  const m = t.model;
  const body = ref.row - 1; // 正文行索引（表头时为 -1）
  const focus = (row: number, col: number) => focusTableCell(view, { from: ref.from, row, col });
  switch (op) {
    case 'row-above': {
      // 表头上面不能插正文行：插到第一行正文
      const at = Math.max(0, body);
      if (!commitModel(view, ref.from, insertRow(m, at))) return false;
      focus(at + 1, ref.col);
      return true;
    }
    case 'row-below': {
      const at = body + 1;
      if (!commitModel(view, ref.from, insertRow(m, at))) return false;
      focus(at + 1, ref.col);
      return true;
    }
    case 'row-delete': {
      if (body < 0) return false; // 表头不能删
      if (!commitModel(view, ref.from, deleteRow(m, body))) return false;
      focus(Math.min(ref.row, m.rows.length - 1), ref.col);
      return true;
    }
    case 'row-up':
    case 'row-down': {
      if (body < 0) return false;
      const dir = op === 'row-up' ? -1 : 1;
      const j = body + dir;
      if (j < 0 || j >= m.rows.length) return false;
      if (!commitModel(view, ref.from, moveRow(m, body, dir))) return false;
      focus(j + 1, ref.col);
      return true;
    }
    case 'col-left':
    case 'col-right': {
      const at = op === 'col-left' ? ref.col : ref.col + 1;
      if (!commitModel(view, ref.from, insertCol(m, at))) return false;
      focus(ref.row, at);
      return true;
    }
    case 'col-delete': {
      const next = deleteCol(m, ref.col);
      if (!next) return runTableOp(view, ref, 'table-delete');
      if (!commitModel(view, ref.from, next)) return false;
      focus(ref.row, Math.min(ref.col, next.header.length - 1));
      return true;
    }
    case 'col-moveleft':
    case 'col-moveright': {
      const dir = op === 'col-moveleft' ? -1 : 1;
      const j = ref.col + dir;
      if (j < 0 || j >= m.header.length) return false;
      if (!commitModel(view, ref.from, moveCol(m, ref.col, dir))) return false;
      focus(ref.row, j);
      return true;
    }
    case 'align-left':
    case 'align-center':
    case 'align-right':
    case 'align-none': {
      const a: Align = op === 'align-none' ? null : (op.slice(6) as Align);
      if (!commitModel(view, ref.from, setAlign(m, ref.col, a))) return false;
      focus(ref.row, ref.col);
      return true;
    }
    case 'table-delete': {
      // 连同表格后面那个换行一起删，别留一个空行
      const to = t.to < view.state.doc.length ? t.to + 1 : t.to;
      (view.dom.ownerDocument.activeElement as HTMLElement | null)?.blur?.();
      view.dispatch({
        changes: { from: t.from, to, insert: '' },
        selection: { anchor: t.from },
        annotations: TableEdit.of(true),
      });
      view.focus();
      return true;
    }
  }
}

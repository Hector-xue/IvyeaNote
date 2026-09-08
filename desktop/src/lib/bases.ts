/**
 * Obsidian Bases（`.base`）读取与求值（v0.11.10）。
 *
 * 用户的原话：「obsidian 的个人空间是这样的，但是我的 ivyeanote 就打不开他的这个」。
 * 在此之前 `.base` 走的是 `openExternal` 那条路——**把文件甩给 Obsidian**，
 * 没装 Obsidian 就只能"在文件夹中定位"。那是兜底，不是打开。
 *
 * `.base` 是一份 YAML：它描述的是「拿库里的笔记按条件筛一遍，用表格显示这几列」。
 * 数据本身还在那些 `.md` 里，所以只要能解析 YAML、能读 frontmatter、能求值那套
 * 过滤表达式，这个视图就能在本地渲染出来，不依赖 Obsidian。
 *
 * ## 明确的边界
 *
 * 支持的是 Bases 语法里**日常真会写的那部分**：
 * - `filters` 的 `and` / `or` / `not` 嵌套，叶子是表达式字符串
 * - 比较：`==` `!=` `>` `>=` `<` `<=`
 * - 方法：`hasTag` `hasLink` `inFolder` `hasProperty` `contains` `containsAny`
 *   `startsWith` `endsWith` `isEmpty` `isNotEmpty`
 * - 文件属性：`file.name` `file.path` `file.ext` `file.folder` `file.tags`
 *   `file.links` `file.mtime` `file.size`
 * - 视图：`type: table` 的 `name` / `order`（列）/ `sort` / `limit` / `filters` / `groupBy`
 *
 * **不支持的一律不装懂**：`formulas`、`summaries`、日期函数、卡片视图等等。
 * 遇到看不懂的表达式，`runBase` 会把它原样放进 `skipped` 交给界面显示——
 * 静默忽略一条筛选，等于给用户看一张多了几十行的表，还不告诉他为什么。
 */
import { load } from 'js-yaml';
import { extractTags } from './tags';
import { extractLinks } from './wikilink';

export interface BaseSort {
  property: string;
  direction?: string;
}

export interface BaseViewSpec {
  type: string;
  name?: string;
  limit?: number;
  filters?: unknown;
  order?: string[];
  sort?: BaseSort[];
  groupBy?: { property: string; direction?: string } | string;
}

export interface BaseSpec {
  filters?: unknown;
  properties?: Record<string, { displayName?: string }>;
  views: BaseViewSpec[];
  /** 解析时就发现的、本版看不懂的顶层键（formulas / summaries…） */
  unsupportedKeys: string[];
}

/** 一条笔记喂给求值器需要的全部东西 */
export interface BaseNote {
  path: string;
  content: string;
  mtime?: number;
  size?: number;
}

export interface BaseRow {
  path: string;
  /** 列 id → 显示用的值（已格式化成字符串；空值是 ''） */
  cells: Record<string, string>;
  /** 分组名；没有 groupBy 时是 null */
  group: string | null;
}

export interface BaseResult {
  columns: { id: string; label: string }[];
  rows: BaseRow[];
  /** 看不懂因而被忽略的过滤表达式原文 */
  skipped: string[];
}

// ---------------------------------------------------------------- 解析

export function parseBase(text: string): BaseSpec {
  let doc: unknown;
  try {
    doc = load(text);
  } catch (e) {
    throw new Error(`这个 .base 文件不是合法的 YAML：${e instanceof Error ? e.message : String(e)}`);
  }
  const obj = (doc && typeof doc === 'object' ? doc : {}) as Record<string, unknown>;
  const views: BaseViewSpec[] = Array.isArray(obj.views)
    ? (obj.views as unknown[])
        .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
        .map((v) => ({
          type: String(v.type ?? 'table'),
          name: v.name === undefined ? undefined : String(v.name),
          limit: typeof v.limit === 'number' ? v.limit : undefined,
          filters: v.filters,
          order: Array.isArray(v.order) ? (v.order as unknown[]).map(String) : undefined,
          sort: normalizeSort(v.sort),
          groupBy: normalizeGroupBy(v.groupBy ?? v.group_by),
        }))
    : [];
  const known = new Set(['filters', 'properties', 'views', 'formulas', 'summaries']);
  const unsupportedKeys = Object.keys(obj).filter((k) => !known.has(k) || k === 'formulas' || k === 'summaries');
  return {
    filters: obj.filters,
    properties: (obj.properties ?? undefined) as BaseSpec['properties'],
    // 一个视图都没写也要能看：默认给一张按文件名排的表
    views: views.length > 0 ? views : [{ type: 'table', name: '全部', order: ['file.name'] }],
    unsupportedKeys,
  };
}

function normalizeSort(v: unknown): BaseSort[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: BaseSort[] = [];
  for (const it of v) {
    if (typeof it === 'string') out.push({ property: it });
    else if (it && typeof it === 'object') {
      const o = it as Record<string, unknown>;
      if (o.property !== undefined) out.push({ property: String(o.property), direction: o.direction ? String(o.direction) : undefined });
    }
  }
  return out.length > 0 ? out : undefined;
}

function normalizeGroupBy(v: unknown): BaseViewSpec['groupBy'] {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.property !== undefined) {
      return { property: String(o.property), direction: o.direction ? String(o.direction) : undefined };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- 笔记属性

/**
 * frontmatter（`---` 包起来的那段 YAML）。
 *
 * 解析失败**不抛**：一篇笔记的 frontmatter 写坏了，不该让整张表打不开。
 */
export function parseFrontmatter(content: string): Record<string, unknown> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(content);
  if (!m) return {};
  try {
    const v = load(m[1]);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface NoteCtx {
  props: Record<string, unknown>;
  file: {
    name: string;
    path: string;
    ext: string;
    folder: string;
    tags: string[];
    links: string[];
    mtime?: number;
    size?: number;
  };
}

export function buildCtx(note: BaseNote): NoteCtx {
  const slash = note.path.lastIndexOf('/');
  const base = slash >= 0 ? note.path.slice(slash + 1) : note.path;
  const dot = base.lastIndexOf('.');
  return {
    props: parseFrontmatter(note.content),
    file: {
      name: dot > 0 ? base.slice(0, dot) : base,
      path: note.path,
      ext: dot > 0 ? base.slice(dot + 1) : '',
      folder: slash >= 0 ? note.path.slice(0, slash) : '',
      tags: extractTags(note.content).map((t) => t.replace(/^#/, '')),
      links: extractLinks(note.content),
      mtime: note.mtime,
      size: note.size,
    },
  };
}

// ---------------------------------------------------------------- 表达式

type Val = unknown;

/** 取值：`file.x` / `note.x` / 裸属性名 */
function lookup(path: string, ctx: NoteCtx): Val {
  const segs = path.split('.');
  if (segs[0] === 'file') return (ctx.file as unknown as Record<string, Val>)[segs[1]];
  const key = segs[0] === 'note' ? segs.slice(1).join('.') : path;
  return ctx.props[key];
}

function literal(src: string): { ok: true; value: Val } | { ok: false } {
  const t = src.trim();
  if (/^"([^"]*)"$/.test(t)) return { ok: true, value: t.slice(1, -1) };
  if (/^'([^']*)'$/.test(t)) return { ok: true, value: t.slice(1, -1) };
  if (/^-?\d+(\.\d+)?$/.test(t)) return { ok: true, value: Number(t) };
  if (t === 'true') return { ok: true, value: true };
  if (t === 'false') return { ok: true, value: false };
  if (t === 'null') return { ok: true, value: null };
  return { ok: false };
}

/*
 * 属性名允许中文。这个用户的库里属性叫「状态」「优先级」是常态——
 * 只认 ASCII 标识符的话，`状态 == "在做"` 会被判成"看不懂"，整条筛选被忽略。
 */
const IDENT = /^[\p{L}_][\p{L}\p{N}_]*(\.[\p{L}_][\p{L}\p{N}_]*)*$/u;

/** `formula.*` / `summary.*` 是本版没实现的东西，**必须当作看不懂**。
 *  当成普通属性去查只会得到 undefined，然后悄无声息地把整条筛选判成 false。 */
function isUnsupportedPath(path: string): boolean {
  return /^(formula|summary)\./.test(path);
}

/** 按顶层逗号切参数（引号内的逗号不算） */
function splitArgs(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (const c of src) {
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 在顶层（不在引号、不在括号里）找比较运算符 */
function findOperator(src: string): { op: string; at: number } | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0) {
      const two = src.slice(i, i + 2);
      if (two === '==' || two === '!=' || two === '>=' || two === '<=') return { op: two, at: i };
      if ((c === '>' || c === '<') && src[i + 1] !== '=') return { op: c, at: i };
    }
  }
  return null;
}

function strOf(v: Val): string {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.map(strOf).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function truthy(v: Val): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.length > 0;
  return !!v;
}

function compare(op: string, a: Val, b: Val): boolean {
  if (op === '==') return looseEq(a, b);
  if (op === '!=') return !looseEq(a, b);
  const x = typeof a === 'number' ? a : Number(strOf(a));
  const y = typeof b === 'number' ? b : Number(strOf(b));
  if (Number.isNaN(x) || Number.isNaN(y)) {
    const sa = strOf(a);
    const sb = strOf(b);
    if (op === '>') return sa > sb;
    if (op === '>=') return sa >= sb;
    if (op === '<') return sa < sb;
    return sa <= sb;
  }
  if (op === '>') return x > y;
  if (op === '>=') return x >= y;
  if (op === '<') return x < y;
  return x <= y;
}

function looseEq(a: Val, b: Val): boolean {
  if (Array.isArray(a)) return a.some((x) => looseEq(x, b));
  if (a === undefined || a === null) return b === undefined || b === null || b === '';
  if (typeof a === 'number' || typeof b === 'number') return Number(strOf(a)) === Number(strOf(b));
  return strOf(a) === strOf(b);
}

export type Predicate = (ctx: NoteCtx) => boolean;

/** 表达式 → 判定函数。看不懂就返回 null，由上层记进 `skipped`。 */
export function compileExpr(src: string): Predicate | null {
  const t = src.trim();
  if (!t) return null;

  if (t.startsWith('!')) {
    const inner = compileExpr(t.slice(1));
    return inner ? (ctx) => !inner(ctx) : null;
  }
  if (t.startsWith('(') && t.endsWith(')') && findOperator(t) === null) {
    const inner = compileExpr(t.slice(1, -1));
    if (inner) return inner;
  }

  const cmp = findOperator(t);
  if (cmp) {
    const left = evalOperand(t.slice(0, cmp.at));
    const right = evalOperand(t.slice(cmp.at + cmp.op.length));
    if (!left || !right) return null;
    return (ctx) => compare(cmp.op, left(ctx), right(ctx));
  }

  const single = evalOperand(t);
  return single ? (ctx) => truthy(single(ctx)) : null;
}

type Operand = (ctx: NoteCtx) => Val;

/** 操作数：字面量 / 属性路径 / 方法调用。看不懂返回 null。 */
function evalOperand(src: string): Operand | null {
  const t = src.trim();
  if (!t) return null;

  const lit = literal(t);
  if (lit.ok) return () => lit.value;

  const call = /^([\p{L}_][\p{L}\p{N}_.]*)\.([A-Za-z][A-Za-z0-9_]*)\((.*)\)$/u.exec(t);
  if (call) {
    const [, objPath, method, argSrc] = call;
    if (isUnsupportedPath(objPath)) return null;
    const args = splitArgs(argSrc).map(evalOperand);
    if (args.some((a) => a === null)) return null;
    const argFns = args as Operand[];
    // `file.hasTag(...)` 这类：对象是 file 本身，参数才是要找的东西
    const target: Operand =
      objPath === 'file' && FILE_METHODS.has(method)
        ? (ctx) => ctx.file
        : (ctx) => lookup(objPath, ctx);
    const fn = METHODS[method];
    if (!fn) return null;
    return (ctx) => fn(target(ctx), argFns.map((a) => a(ctx)), ctx);
  }

  if (IDENT.test(t) && !isUnsupportedPath(t)) return (ctx) => lookup(t, ctx);
  return null;
}

const FILE_METHODS = new Set(['hasTag', 'hasLink', 'inFolder', 'hasProperty']);

const METHODS: Record<string, (target: Val, args: Val[], ctx: NoteCtx) => Val> = {
  hasTag: (_t, args, ctx) =>
    args.some((a) =>
      ctx.file.tags.some((tag) => tag.toLowerCase() === strOf(a).replace(/^#/, '').toLowerCase())
    ),
  hasLink: (_t, args, ctx) =>
    args.some((a) => {
      const want = strOf(a).toLowerCase();
      return ctx.file.links.some((l) => {
        const low = l.toLowerCase();
        return low === want || low.replace(/\.md$/, '') === want.replace(/\.md$/, '');
      });
    }),
  inFolder: (_t, args, ctx) =>
    args.some((a) => {
      const f = strOf(a).replace(/\/$/, '');
      return ctx.file.folder === f || ctx.file.folder.startsWith(`${f}/`);
    }),
  hasProperty: (_t, args, ctx) => args.some((a) => strOf(a) in ctx.props),
  contains: (t, args) =>
    args.some((a) =>
      Array.isArray(t)
        ? t.some((x) => strOf(x).toLowerCase() === strOf(a).toLowerCase())
        : strOf(t).toLowerCase().includes(strOf(a).toLowerCase())
    ),
  containsAny: (t, args) =>
    args.some((a) =>
      Array.isArray(t)
        ? t.some((x) => strOf(x).toLowerCase() === strOf(a).toLowerCase())
        : strOf(t).toLowerCase().includes(strOf(a).toLowerCase())
    ),
  startsWith: (t, args) => args.some((a) => strOf(t).toLowerCase().startsWith(strOf(a).toLowerCase())),
  endsWith: (t, args) => args.some((a) => strOf(t).toLowerCase().endsWith(strOf(a).toLowerCase())),
  isEmpty: (t) => !truthy(t),
  isNotEmpty: (t) => truthy(t),
};

// ---------------------------------------------------------------- 过滤树

interface CompiledFilter {
  test: Predicate;
  skipped: string[];
}

export function compileFilters(node: unknown): CompiledFilter {
  const skipped: string[] = [];
  const test = build(node, skipped) ?? (() => true);
  return { test, skipped };
}

function build(node: unknown, skipped: string[]): Predicate | null {
  if (node === undefined || node === null) return null;
  if (typeof node === 'string') {
    const fn = compileExpr(node);
    if (!fn) skipped.push(node);
    return fn;
  }
  if (Array.isArray(node)) {
    const fns = node.map((n) => build(n, skipped)).filter((f): f is Predicate => !!f);
    return fns.length > 0 ? (ctx) => fns.every((f) => f(ctx)) : null;
  }
  if (typeof node === 'object') {
    const o = node as Record<string, unknown>;
    const parts: Predicate[] = [];
    if (o.and !== undefined) {
      const fns = toList(o.and).map((n) => build(n, skipped)).filter((f): f is Predicate => !!f);
      if (fns.length > 0) parts.push((ctx) => fns.every((f) => f(ctx)));
    }
    if (o.or !== undefined) {
      const fns = toList(o.or).map((n) => build(n, skipped)).filter((f): f is Predicate => !!f);
      if (fns.length > 0) parts.push((ctx) => fns.some((f) => f(ctx)));
    }
    if (o.not !== undefined) {
      const fns = toList(o.not).map((n) => build(n, skipped)).filter((f): f is Predicate => !!f);
      if (fns.length > 0) parts.push((ctx) => !fns.some((f) => f(ctx)));
    }
    return parts.length > 0 ? (ctx) => parts.every((f) => f(ctx)) : null;
  }
  return null;
}

function toList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [v];
}

// ---------------------------------------------------------------- 求值

function cellValue(col: string, ctx: NoteCtx): Val {
  return lookup(col, ctx);
}

function labelOf(col: string, spec: BaseSpec): string {
  const named = spec.properties?.[col]?.displayName;
  if (named) return named;
  if (col === 'file.name') return '名称';
  if (col === 'file.path') return '路径';
  if (col === 'file.folder') return '文件夹';
  if (col === 'file.ext') return '扩展名';
  if (col === 'file.tags') return '标签';
  if (col === 'file.mtime') return '修改时间';
  if (col === 'file.size') return '大小';
  return col.replace(/^note\./, '');
}

function display(col: string, v: Val): string {
  if (v === undefined || v === null) return '';
  if (col === 'file.mtime' && typeof v === 'number') return new Date(v).toLocaleString('zh-CN');
  if (col === 'file.size' && typeof v === 'number') {
    return v < 1024 ? `${v} B` : v < 1024 * 1024 ? `${(v / 1024).toFixed(1)} KB` : `${(v / 1024 / 1024).toFixed(1)} MB`;
  }
  return strOf(v);
}

/** 跑一个视图：过滤 → 排序 → 分组 → 截断 */
export function runBase(spec: BaseSpec, view: BaseViewSpec, notes: BaseNote[]): BaseResult {
  const top = compileFilters(spec.filters);
  const own = compileFilters(view.filters);
  const skipped = [...top.skipped, ...own.skipped];

  const cols = view.order && view.order.length > 0 ? view.order : ['file.name'];
  const columns = cols.map((id) => ({ id, label: labelOf(id, spec) }));

  const groupProp = typeof view.groupBy === 'string' ? view.groupBy : view.groupBy?.property;

  let rows: (BaseRow & { ctx: NoteCtx })[] = [];
  for (const n of notes) {
    const ctx = buildCtx(n);
    if (!top.test(ctx) || !own.test(ctx)) continue;
    const cells: Record<string, string> = {};
    for (const c of cols) cells[c] = display(c, cellValue(c, ctx));
    rows.push({
      path: n.path,
      cells,
      group: groupProp ? display(groupProp, cellValue(groupProp, ctx)) || '（空）' : null,
      ctx,
    });
  }

  const sorts = view.sort ?? [{ property: cols[0], direction: 'ASC' }];
  rows.sort((a, b) => {
    for (const s of sorts) {
      const av = cellValue(s.property, a.ctx);
      const bv = cellValue(s.property, b.ctx);
      const dir = (s.direction ?? 'ASC').toUpperCase() === 'DESC' ? -1 : 1;
      let d: number;
      if (typeof av === 'number' && typeof bv === 'number') d = av - bv;
      else d = strOf(av).localeCompare(strOf(bv), 'zh-Hans-CN');
      if (d !== 0) return d * dir;
    }
    return 0;
  });

  if (groupProp) {
    rows.sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '', 'zh-Hans-CN'));
  }
  if (typeof view.limit === 'number' && view.limit >= 0) rows = rows.slice(0, view.limit);

  return { columns, rows: rows.map(({ ctx: _ctx, ...r }) => r), skipped };
}

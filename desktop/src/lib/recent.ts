/**
 * 最近打开（v0.7.10 E6）。
 *
 * 快速切换器（Ctrl+O）此前按文件名字母序列出全部笔记——而人找的几乎总是
 * 「刚才那几篇」。按最近打开排序，命中率天差地别。
 *
 * 只存路径，不存内容；上限固定，避免无限膨胀。
 */
const KEY = 'ivnote.recent';
const MAX = 50;

export function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? (v as string[]).slice(0, MAX) : [];
  } catch {
    return [];
  }
}

/** 记一次打开：置顶、去重、截断。返回新列表（纯函数，便于单测） */
export function pushRecent(list: readonly string[], path: string): string[] {
  return [path, ...list.filter((p) => p !== path)].slice(0, MAX);
}

export function saveRecent(list: readonly string[]): void {
  localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
}

/**
 * 按最近打开排序：最近的在前，没打开过的按原顺序排在后面。
 * 已经不存在的路径自动落选（recent 里可能留着已删除的笔记）。
 */
export function orderByRecent<T>(
  items: readonly T[],
  recent: readonly string[],
  pathOf: (item: T) => string
): T[] {
  const rank = new Map(recent.map((p, i) => [p, i]));
  return [...items].sort((a, b) => {
    const ra = rank.get(pathOf(a)) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(pathOf(b)) ?? Number.MAX_SAFE_INTEGER;
    return ra - rb;
  });
}

/**
 * 改名 / 移动后把 recent 里的旧路径换成新路径。
 *
 * 不做这一步，「按最近打开排序」在最高频的那条路径上直接失效：新建笔记先落盘成
 * `untitled.md`（recent 记的是它），写下 H1 后标题跟随把文件改成了 `广告优化.md`——
 * recent 里留下一条指向已删除文件的死路径，排序退化回文件名序。
 *
 * 批量形式与 `remapTabs` 一致，移动整个文件夹时一次带走全部子路径。
 */
export function remapRecent(
  list: readonly string[],
  ops: readonly { from: string; to: string }[]
): string[] {
  if (ops.length === 0) return [...list];
  const map = new Map(ops.map((o) => [o.from, o.to]));
  const out: string[] = [];
  for (const p of list) {
    const next = map.get(p) ?? p;
    // 改名可能把两条历史合成同一条（旧名 + 新名都在表里），去重保序
    if (!out.includes(next)) out.push(next);
  }
  return out;
}

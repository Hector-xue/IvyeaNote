/**
 * 顶栏标签页（v0.11.11 重新引入）。
 *
 * # 为什么是"重新"
 *
 * v0.10.7 删过一次标签栏，当时用户的原话是「顶栏太丑了，删掉吧」——删掉的是
 * **单独占一整行、空荡荡的那条栏**，不是"标签"这个能力本身。现在他要的是
 * Obsidian 那样：标签就长在顶栏里，顺便把那条本来就有点空的栏填满。
 *
 * 所以这次的形状不同：不新增一行，标签直接占据顶栏中间那块原来放面包屑的位置。
 *
 * # 这里只管状态，不碰 IO
 *
 * 打开一篇笔记要读盘，那是 App 的事；这个 hook 只回答「现在开着哪几篇、
 * 哪一篇在前台」，并保证三件容易漏的事：
 *
 * 1. **持久化**：关掉应用再打开，标签还在（顺带满足"回到退出前那篇"）；
 * 2. **路径重映射**：文件被移动或重命名后，标签里存的还是旧路径——
 *    这正是 `useOpenNote` 当初留下 `remap` 出口的原因，多标签之后更容易漏；
 * 3. **关掉当前标签之后该激活谁**：Obsidian 是激活右边那个，没有右边就左边。
 *    随便挑一个的话，用户每关一次都要重新找位置。
 */
import { useCallback, useEffect, useState } from 'react';

const TABS_KEY = 'ivnote.tabs';
const ACTIVE_KEY = 'ivnote.activeTab';
/** 上限：标签多到这个数已经没人用眼睛找了，再多只会把顶栏挤成一条线 */
const MAX_TABS = 12;

export interface TabsDeps {
  /** 真正把内容读出来显示（由 App 提供，hook 不碰 IO） */
  openFile(path: string): Promise<void>;
}

export interface Tabs {
  /** 打开着的笔记路径，按打开顺序 */
  tabs: string[];
  /** 当前这篇；null＝没开 */
  activeNote: string | null;
  /** 打开（已开着就只是切过去） */
  open(path: string): Promise<void>;
  /** 关掉一个标签；返回关完之后该激活谁（null＝一个都不剩） */
  close(path: string): string | null;
  /** 路径变了（移动/重命名）→ 同步更新，避免记着一个不存在的文件 */
  remap(pairs: readonly { from: string; to: string }[]): void;
  /** 库里已经没有这些路径了（外部删除 / 换库）→ 清掉对应标签 */
  prune(existing: readonly string[]): void;
}

function loadTabs(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(TABS_KEY) ?? '[]');
    return Array.isArray(v) ? (v as string[]).slice(0, MAX_TABS) : [];
  } catch {
    return [];
  }
}

/**
 * 关掉 `path` 之后该激活谁：右边优先，没有右边取左边，都没有就 null。
 * 纯函数，便于单测。
 */
export function nextActiveAfterClose(
  tabs: readonly string[],
  closing: string,
  active: string | null
): string | null {
  if (active !== closing) return active; // 关的不是当前这篇，前台不动
  const i = tabs.indexOf(closing);
  if (i < 0) return active;
  return tabs[i + 1] ?? tabs[i - 1] ?? null;
}

export function useTabs(deps: TabsDeps): Tabs {
  const { openFile } = deps;
  const [tabs, setTabs] = useState<string[]>(loadTabs);
  const [activeNote, setActiveNote] = useState<string | null>(() =>
    localStorage.getItem(ACTIVE_KEY)
  );

  useEffect(() => {
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify(tabs.slice(0, MAX_TABS)));
      if (activeNote) localStorage.setItem(ACTIVE_KEY, activeNote);
      else localStorage.removeItem(ACTIVE_KEY);
    } catch {
      /* 存不下就算了，不该让打开笔记这件事失败 */
    }
  }, [tabs, activeNote]);

  const open = useCallback(
    async (path: string) => {
      setTabs((cur) => (cur.includes(path) ? cur : [...cur, path].slice(-MAX_TABS)));
      setActiveNote(path);
      await openFile(path);
    },
    [openFile]
  );

  const close = useCallback(
    (path: string): string | null => {
      /*
       * 先用**当前**的 tabs 把"接下来激活谁"算出来，再去 setState。
       *
       * 曾经写成在 `setTabs(cur => …)` 的回调里给 `next` 赋值、然后同一个 tick
       * 读它——那个回调要等 React 提交阶段才跑，读到的永远是初始值 `null`，
       * 于是"关掉当前标签"变成"掉回空白页"。`nextActiveAfterClose` 是纯函数，
       * 本来就该在这里直接调用；绕回调等于把它的输入换成了未来的值。
       */
      const next = nextActiveAfterClose(tabs, path, activeNote);
      setTabs((cur) => cur.filter((p) => p !== path));
      setActiveNote((cur) => (cur === path ? next : cur));
      return next;
    },
    [tabs, activeNote]
  );

  const remap = useCallback((pairs: readonly { from: string; to: string }[]) => {
    if (pairs.length === 0) return;
    const map = new Map(pairs.map((p) => [p.from, p.to]));
    setTabs((cur) => cur.map((p) => map.get(p) ?? p));
    setActiveNote((cur) => (cur ? (map.get(cur) ?? cur) : cur));
  }, []);

  const prune = useCallback((existing: readonly string[]) => {
    const alive = new Set(existing);
    setTabs((cur) => (cur.every((p) => alive.has(p)) ? cur : cur.filter((p) => alive.has(p))));
    setActiveNote((cur) => (cur && !alive.has(cur) ? null : cur));
  }, []);

  return { tabs, activeNote, open, close, remap, prune };
}

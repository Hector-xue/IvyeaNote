/**
 * 多标签页（从 App.tsx 抽出，v0.7.8）。
 *
 * 打开的笔记路径列表 + 当前激活标签，持久化到 localStorage。
 *
 * 抽出来的额外收获：标签的「路径重映射」有了唯一出口。文件被移动或重命名后，
 * 标签里存的还是旧路径——点上去就是一个已经不存在的文件。原来只有拖拽移动那条
 * 路径记得处理，重命名那条忘了。现在两边都调 `remap()`。
 */
import { useCallback, useEffect, useState } from 'react';

const TABS_KEY = 'ivnote.tabs';
const ACTIVE_KEY = 'ivnote.activeTab';

export interface TabsDeps {
  /** 真正把内容读出来显示（由 App 提供，hook 不碰 IO） */
  openFile(path: string): Promise<void>;
  /** 最后一个标签被关掉时调用：清空编辑区 */
  onEmpty(): void;
}

export interface Tabs {
  openTabs: string[];
  activeTab: string | null;
  /** 打开笔记：确保标签存在并激活 */
  openInTab(path: string): Promise<void>;
  /** 关闭标签：若关的是当前标签，切到相邻的那个 */
  closeTab(path: string): void;
  /** 路径变了（移动/重命名）→ 同步更新标签，避免指向不存在的文件 */
  remap(pairs: readonly { from: string; to: string }[]): void;
}

function loadTabs(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(TABS_KEY) ?? '[]');
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

export function useTabs(deps: TabsDeps): Tabs {
  const { openFile, onEmpty } = deps;
  const [openTabs, setOpenTabs] = useState<string[]>(loadTabs);
  const [activeTab, setActiveTab] = useState<string | null>(() =>
    localStorage.getItem(ACTIVE_KEY)
  );

  useEffect(() => {
    localStorage.setItem(TABS_KEY, JSON.stringify(openTabs));
    if (activeTab) localStorage.setItem(ACTIVE_KEY, activeTab);
    else localStorage.removeItem(ACTIVE_KEY);
  }, [openTabs, activeTab]);

  const openInTab = useCallback(
    async (path: string) => {
      setOpenTabs((tabs) => (tabs.includes(path) ? tabs : [...tabs, path]));
      setActiveTab(path);
      await openFile(path);
    },
    [openFile]
  );

  const closeTab = useCallback(
    (path: string) => {
      setOpenTabs((tabs) => {
        const idx = tabs.indexOf(path);
        const next = tabs.filter((t) => t !== path);
        setActiveTab((cur) => {
          if (cur !== path) return cur;
          const fallback = next[Math.min(idx, next.length - 1)] ?? null;
          if (fallback) void openFile(fallback);
          else onEmpty();
          return fallback;
        });
        return next;
      });
    },
    [openFile, onEmpty]
  );

  const remap = useCallback((pairs: readonly { from: string; to: string }[]) => {
    if (pairs.length === 0) return;
    const map = new Map(pairs.map((p) => [p.from, p.to]));
    setOpenTabs((tabs) => tabs.map((t) => map.get(t) ?? t));
    setActiveTab((cur) => (cur ? (map.get(cur) ?? cur) : cur));
  }, []);

  return { openTabs, activeTab, openInTab, closeTab, remap };
}

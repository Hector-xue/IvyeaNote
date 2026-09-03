/**
 * 当前打开的笔记（v0.10.7，前身是 `useTabs`）。
 *
 * v0.10.7 删掉了顶部标签栏（用户：「顶栏太丑了，删掉吧」），于是「打开了哪几篇」
 * 这份列表**没有任何地方再消费它**了。留着一份没人看的 state，正是这个仓库
 * 最容易长出来的那种东西，所以一并收掉：这里只剩两件仍然有人用的事——
 *
 * 1. **打开一篇笔记**（并记住是哪一篇，写进 localStorage）；
 * 2. **路径重映射**：文件被移动或重命名后，记着的还是旧路径。
 *    原来只有拖拽移动那条路径记得处理，重命名那条忘了——这个出口就是为它留的。
 */
import { useCallback, useEffect, useState } from 'react';

const ACTIVE_KEY = 'ivnote.activeTab';

export interface OpenNoteDeps {
  /** 真正把内容读出来显示（由 App 提供，hook 不碰 IO） */
  openFile(path: string): Promise<void>;
}

export interface OpenNote {
  /** 当前这篇的库内路径；null＝没开 */
  activeNote: string | null;
  /** 打开一篇笔记 */
  open(path: string): Promise<void>;
  /** 路径变了（移动/重命名）→ 同步更新，避免记着一个不存在的文件 */
  remap(pairs: readonly { from: string; to: string }[]): void;
}

export function useOpenNote(deps: OpenNoteDeps): OpenNote {
  const { openFile } = deps;
  const [activeNote, setActiveNote] = useState<string | null>(() =>
    localStorage.getItem(ACTIVE_KEY)
  );

  useEffect(() => {
    if (activeNote) localStorage.setItem(ACTIVE_KEY, activeNote);
    else localStorage.removeItem(ACTIVE_KEY);
  }, [activeNote]);

  const open = useCallback(
    async (path: string) => {
      setActiveNote(path);
      await openFile(path);
    },
    [openFile]
  );

  const remap = useCallback((pairs: readonly { from: string; to: string }[]) => {
    if (pairs.length === 0) return;
    const map = new Map(pairs.map((p) => [p.from, p.to]));
    setActiveNote((cur) => (cur ? (map.get(cur) ?? cur) : cur));
  }, []);

  return { activeNote, open, remap };
}

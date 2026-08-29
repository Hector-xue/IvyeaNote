/**
 * 库内文件列表（从 App.tsx 抽出，v0.7.8）。
 *
 * 这是整个应用的**数据咽喉**：新建 / 删除 / 重命名 / 移动 / 导入 / 回收站 /
 * 同步拉取 / 文件监听，每一条路径最后都要走到 `refresh()`。v0.7.4 之前
 * 「反链恒空」那个缺陷的根源，就是有一份派生数据（全库正文索引）没挂在这个咽喉上。
 *
 * 所以这里一次 `listMeta` 同时产出三样东西，杜绝「有人忘了更新其中一样」：
 * - `files` / `pdfs`：侧栏渲染用，按当前排序整理过；
 * - `mdStamps`：喂给 `useNoteIndex` 做增量对账的指纹；
 * - `metaOf` / `allPaths`：重名消解、移动落点计算要看**全部**已知路径，
 *   只看 files 会漏掉附件和 .keep。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileIO, FileMeta } from '../lib/sync';
import { isIndexable, type FileStamp } from '../lib/noteIndex';

export type SortMode = 'name' | 'mtime';

const SORT_KEY = 'ivnote.sort';
/** 回收站不进主列表 */
const HIDDEN_PREFIXES = ['.trash/', '.ivyea/'];

export function loadSortMode(): SortMode {
  return localStorage.getItem(SORT_KEY) === 'mtime' ? 'mtime' : 'name';
}

export interface VaultFiles {
  /** .md 列表，已按 sortMode 排序 */
  files: string[];
  /** .pdf 列表，已按 sortMode 排序 */
  pdfs: string[];
  /** 可索引文件的指纹快照，驱动全库正文索引的增量对账 */
  mdStamps: FileStamp[];
  /** 库内全部已知路径（含附件、.keep），重名消解与移动计算要用 */
  allPaths(): string[];
  metaOf(path: string): FileMeta | undefined;
  sortMode: SortMode;
  setSortMode(m: SortMode): void;
  /** 重新扫描。**所有会改动文件的操作最后都必须调它** */
  refresh(): Promise<void>;
}

export function useVaultFiles(io: FileIO, vaultPath: string | null): VaultFiles {
  // 原始列表进 state，排序用 useMemo 派生——这样「换个排序方式」只是重排，
  // 不会连带触发一次全盘重扫（把排序塞进 refresh 的依赖里就会）
  const [rawMd, setRawMd] = useState<string[]>([]);
  const [rawPdf, setRawPdf] = useState<string[]>([]);
  const [mdStamps, setMdStamps] = useState<FileStamp[]>([]);
  const [sortMode, setSortModeState] = useState<SortMode>(loadSortMode);
  const metasRef = useRef<Map<string, FileMeta>>(new Map());

  const refresh = useCallback(async () => {
    if (vaultPath === null) return;
    try {
      // 一次 listMeta 拿全路径 + mtime + size，三份派生数据一起更新
      const metas = await io.listMeta(vaultPath);
      metasRef.current = new Map(metas.map((m) => [m.path, m]));
      const visible = metas
        .map((m) => m.path)
        .filter((p) => !HIDDEN_PREFIXES.some((h) => p.startsWith(h)));
      setRawMd(visible.filter((p) => /\.md$/i.test(p)));
      setRawPdf(visible.filter((p) => /\.pdf$/i.test(p)));
      setMdStamps(
        metas
          .filter((m) => isIndexable(m.path))
          .map((m) => ({ path: m.path, mtime: m.mtime, size: m.size }))
      );
    } catch (e) {
      console.error('列出文件失败', e);
    }
  }, [io, vaultPath]);

  // 换库 / 换存储后端 → 立刻重扫，不要留着上一个库的列表
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sortList = useCallback(
    (list: string[]): string[] => {
      const metas = metasRef.current;
      if (sortMode === 'mtime') {
        return [...list].sort((a, b) => (metas.get(b)?.mtime ?? 0) - (metas.get(a)?.mtime ?? 0));
      }
      return [...list].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    },
    [sortMode]
  );

  const files = useMemo(() => sortList(rawMd), [rawMd, sortList]);
  const pdfs = useMemo(() => sortList(rawPdf), [rawPdf, sortList]);

  const setSortMode = useCallback((m: SortMode) => {
    setSortModeState(m);
    localStorage.setItem(SORT_KEY, m);
  }, []);

  const allPaths = useCallback(
    () => [...metasRef.current.keys()].filter((p) => !p.startsWith('.trash/')),
    []
  );
  const metaOf = useCallback((path: string) => metasRef.current.get(path), []);

  return useMemo(
    () => ({ files, pdfs, mdStamps, allPaths, metaOf, sortMode, setSortMode, refresh }),
    [files, pdfs, mdStamps, allPaths, metaOf, sortMode, setSortMode, refresh]
  );
}

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
/** 空文件夹的占位文件（新建文件夹时写入） */
const KEEP = '/.keep';

export function loadSortMode(): SortMode {
  return localStorage.getItem(SORT_KEY) === 'mtime' ? 'mtime' : 'name';
}

export interface VaultFiles {
  /** .md 列表，已按 sortMode 排序 */
  files: string[];
  /** .pdf 列表，已按 sortMode 排序 */
  pdfs: string[];
  /**
   * 库里**全部可见文件**（.md / .pdf / 图片 / 任何附件），已排序，不含 `.keep` 占位。
   *
   * v0.11.1 新增：侧栏文件树此前只由 `.md` 构建，PDF 是钉在侧栏最底下的一个
   * 扁平分组——几十篇笔记的库里它被压在整棵树下面老远，而且
   * `obsidian/文章/x.pdf` 会脱离所在文件夹只剩个文件名。用户的原话是
   * 「pdf 依旧识别不到」，其实一直都"在"，只是没人找得到。Obsidian 是把
   * 所有文件都摆在它所在的文件夹里的，现在对齐它。
   */
  allFiles: string[];
  /** 可索引文件的指纹快照，驱动全库正文索引的增量对账 */
  mdStamps: FileStamp[];
  /** 只有 .keep 占位的空文件夹，供侧栏建树 */
  emptyDirs: string[];
  /** 库内全部已知路径（含附件、.keep），重名消解与移动计算要用 */
  allPaths(): string[];
  metaOf(path: string): FileMeta | undefined;
  sortMode: SortMode;
  setSortMode(m: SortMode): void;
  /** 重新扫描。**所有会改动文件的操作最后都必须调它** */
  refresh(): Promise<void>;
  /**
   * v0.11.30：**当前这个库**的列表至少成功扫过一次。
   *
   * `files.length === 0` 分不清"空库"和"还没扫完"——从桌面快捷方式进来要「新建笔记」时
   * 必须等它：新建靠 files 算不重名的文件名，列表没到就可能覆盖已有的 untitled.md。
   * 换库即回到 false。
   */
  loaded: boolean;
}

export function useVaultFiles(io: FileIO, vaultPath: string | null): VaultFiles {
  // 原始列表进 state，排序用 useMemo 派生——这样「换个排序方式」只是重排，
  // 不会连带触发一次全盘重扫（把排序塞进 refresh 的依赖里就会）
  const [rawMd, setRawMd] = useState<string[]>([]);
  const [rawPdf, setRawPdf] = useState<string[]>([]);
  const [rawAll, setRawAll] = useState<string[]>([]);
  const [mdStamps, setMdStamps] = useState<FileStamp[]>([]);
  const [emptyDirs, setEmptyDirs] = useState<string[]>([]);
  const [sortMode, setSortModeState] = useState<SortMode>(loadSortMode);
  const metasRef = useRef<Map<string, FileMeta>>(new Map());
  /** 哪个 vaultPath 已经扫成功过；与当前 vaultPath 不等就是"还没" */
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

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
      // `.keep` 是空文件夹的占位，它本身不该出现在树里（目录由 emptyDirs 单独给）
      setRawAll(visible.filter((p) => !p.endsWith(KEEP)));
      setMdStamps(
        metas
          .filter((m) => isIndexable(m.path))
          .map((m) => ({ path: m.path, mtime: m.mtime, size: m.size }))
      );
      // 空文件夹靠 .keep 占位标记。侧栏的树是从 .md 路径推导的，推不出空目录——
      // 不在这儿单独算一份，「新建文件夹」在用户眼里就是「点了没反应」。
      // （不能在 App 里用 allPaths 算：那是个读 ref 的稳定回调，放进 useMemo 依赖永不重算。）
      setEmptyDirs(
        visible.filter((p) => p.endsWith(KEEP)).map((p) => p.slice(0, -KEEP.length))
      );
      setLoadedFor(vaultPath);
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
  const allFiles = useMemo(() => sortList(rawAll), [rawAll, sortList]);

  const setSortMode = useCallback((m: SortMode) => {
    setSortModeState(m);
    localStorage.setItem(SORT_KEY, m);
  }, []);

  const allPaths = useCallback(
    () => [...metasRef.current.keys()].filter((p) => !p.startsWith('.trash/')),
    []
  );
  const metaOf = useCallback((path: string) => metasRef.current.get(path), []);
  const loaded = vaultPath !== null && loadedFor === vaultPath;

  return useMemo(
    () => ({ files, pdfs, allFiles, mdStamps, emptyDirs, allPaths, metaOf, sortMode, setSortMode, refresh, loaded }),
    [files, pdfs, allFiles, mdStamps, emptyDirs, allPaths, metaOf, sortMode, setSortMode, refresh, loaded]
  );
}

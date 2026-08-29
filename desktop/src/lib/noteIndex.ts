/**
 * 全库正文索引（v0.7.5 P0）。
 *
 * 为什么要有这个模块：v0.7.4 的头号缺陷是全库正文缓存 `searchDocs` 只在打开
 * 命令面板时建**一次**、此后永不更新（`if (searchDocs.length > 0) return`）。
 * 后果是——桌面端没按过 Ctrl+K 之前反链恒空；移动端根本没有触发入口，
 * 所以「反向链接区块」在真机上从未显示过；建完之后新写的笔记也不进索引。
 *
 * 修法不是「多补几处调用」，而是把索引挂到 `refreshFiles` 这**唯一咽喉**上：
 * 新建 / 删除 / 重命名 / 移动 / 导入 / 回收站 / 同步拉取，每一条路径最后都会
 * 走 refreshFiles，因此索引自动跟上，从结构上杜绝「线没接上」。
 *
 * 对账按 `mtime + size` 判定单文件是否变更，只重读变了的那几个，不是每次全量读盘。
 *
 * P1 会把存储换成 SQLite/FTS5，届时只替换本模块内部实现，
 * 对外形状（NoteIndex）保持不变，消费方不用改。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileIO } from './sync';
import type { SearchDoc } from './searchIndex';

/** 文件指纹：用于判断内容是否需要重读 */
export interface FileStamp {
  path: string;
  mtime: number;
  size: number;
}

export interface IndexEntry extends FileStamp {
  content: string;
}

export interface IndexDiff {
  /** 需要重新读盘的文件（新增或指纹变化） */
  toRead: FileStamp[];
  /** 已从库中消失、需要移出索引的路径 */
  toDrop: string[];
}

/**
 * 纯函数：对比当前索引与最新文件指纹，算出增量。
 * 抽成纯函数是为了能单测——这层出错会静默表现为「搜不到 / 反链空」，很难靠手点发现。
 */
export function diffIndex(
  current: ReadonlyMap<string, IndexEntry>,
  stamps: readonly FileStamp[]
): IndexDiff {
  const toRead: FileStamp[] = [];
  const seen = new Set<string>();
  for (const s of stamps) {
    seen.add(s.path);
    const cur = current.get(s.path);
    if (!cur || cur.mtime !== s.mtime || cur.size !== s.size) toRead.push(s);
  }
  const toDrop: string[] = [];
  for (const p of current.keys()) if (!seen.has(p)) toDrop.push(p);
  return { toRead, toDrop };
}

export interface NoteIndex {
  /** 供搜索 / 标签 / 双链反链 / 图谱消费 */
  docs: SearchDoc[];
  /** 首轮对账是否已完成（用于「索引建立中」提示） */
  ready: boolean;
  /**
   * 编辑器内即时更新单条。
   * 必要性：未登录的本地模式下 `doSync()` 会直接 return，不会触发 refreshFiles，
   * 光靠咽喉对账的话，离线写作时反链要等下一次文件列表刷新才更新。
   */
  touch(path: string, content: string): void;
  /** 手动全量重建（索引怀疑不一致时的兜底） */
  rebuild(): void;
}

/** 只索引 Markdown；附件/PDF、回收站、软件自己的元数据目录都不进正文索引 */
export function isIndexable(path: string): boolean {
  return (
    /\.(md|markdown)$/i.test(path) &&
    !path.startsWith('.trash/') &&
    !path.startsWith('.ivyea/')
  );
}

// ---------------------------------------------------------------------------
// 索引快照持久化
//
// 目的只有一个：**别在每次启动时把整个库重读一遍**。几千篇笔记走 Tauri IPC
// 逐个读，是启动最慢的一段。快照存下来后，启动只读 1 个文件，再按 mtime+size
// 对账，只重读真正变过的那几篇。
//
// 快照是**可丢弃缓存**，不是真相：它过期、损坏、被人手删，结果都只是「这次多读几个
// 文件」，不会读错内容——因为对账永远以磁盘上的 mtime+size 为准。

const CACHE_PATH = '.ivyea/cache/content.json';
const CACHE_VERSION = 1;

interface CacheFile {
  v: number;
  entries: [string, number, number, string][]; // [path, mtime, size, content]
}

export async function loadIndexCache(
  io: FileIO,
  vaultPath: string
): Promise<Map<string, IndexEntry>> {
  const map = new Map<string, IndexEntry>();
  try {
    const raw = await io.read(vaultPath, CACHE_PATH);
    const data = JSON.parse(raw) as CacheFile;
    if (data.v !== CACHE_VERSION || !Array.isArray(data.entries)) return map;
    for (const [path, mtime, size, content] of data.entries) {
      if (typeof path === 'string' && typeof content === 'string' && isIndexable(path)) {
        map.set(path, { path, mtime, size, content });
      }
    }
  } catch {
    // 没有快照 / 解析失败：当成空索引，全量重建。这是设计内的降级，不是错误。
  }
  return map;
}

export async function saveIndexCache(
  io: FileIO,
  vaultPath: string,
  map: ReadonlyMap<string, IndexEntry>
): Promise<void> {
  const data: CacheFile = {
    v: CACHE_VERSION,
    entries: [...map.values()].map((e) => [e.path, e.mtime, e.size, e.content]),
  };
  try {
    await io.write(vaultPath, CACHE_PATH, JSON.stringify(data));
  } catch {
    // 写不进去不影响使用，下次启动全量重建而已
  }
}

/**
 * @param stamps 当前库内全部可索引文件的指纹。**每次 refreshFiles 后都要更新它**，
 *               哪怕内容没变（数组换新引用即可触发对账，无变更时对账几乎零成本）。
 */
export function useNoteIndex(
  io: FileIO,
  vaultPath: string,
  stamps: readonly FileStamp[]
): NoteIndex {
  // 索引本体放 ref、用 version 触发重渲染：避免「读到上一轮 state」导致的重复读盘
  const mapRef = useRef<Map<string, IndexEntry>>(new Map());
  const [version, setVersion] = useState(0);
  const [ready, setReady] = useState(false);
  const runRef = useRef(0);
  /** 本轮 vault 是否已尝试过读快照（只读一次） */
  const hydratedRef = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);

  // vault 切换：整个索引作废，快照也要重读
  const lastVault = useRef(vaultPath);
  if (lastVault.current !== vaultPath) {
    lastVault.current = vaultPath;
    mapRef.current = new Map();
    hydratedRef.current = false;
  }

  /** 延迟落快照。编辑时每次落盘都存一遍太浪费，而快照过期是自愈的
   *  （下次对账按 mtime+size 发现不一致就重读），所以拖长一点完全安全。 */
  const scheduleSave = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void saveIndexCache(io, vaultPath, mapRef.current);
    }, 10_000);
  }, [io, vaultPath]);

  useEffect(() => {
    const run = ++runRef.current;
    let cancelled = false;
    const stale = () => cancelled || run !== runRef.current;

    void (async () => {
      // 首轮先吃快照：把上次的正文直接装进来，接着的对账就只需重读变过的那几篇，
      // 而不是把几千个文件重新走一遍 IPC。
      if (!hydratedRef.current) {
        hydratedRef.current = true;
        const cached = await loadIndexCache(io, vaultPath);
        if (stale()) return;
        if (mapRef.current.size === 0 && cached.size > 0) {
          mapRef.current = cached;
          setVersion((v) => v + 1);
        }
      }

      const { toRead, toDrop } = diffIndex(mapRef.current, stamps);
      if (toRead.length === 0 && toDrop.length === 0) {
        setReady(true);
        return;
      }
      const fresh: IndexEntry[] = [];
      for (const s of toRead) {
        if (stale()) return;
        try {
          fresh.push({ ...s, content: await io.read(vaultPath, s.path) });
        } catch {
          // 单文件读失败不影响其余：下一轮对账会再试
        }
      }
      if (stale()) return;
      for (const p of toDrop) mapRef.current.delete(p);
      for (const e of fresh) mapRef.current.set(e.path, e);
      setVersion((v) => v + 1);
      setReady(true);
      scheduleSave();
    })();

    return () => {
      cancelled = true;
    };
  }, [io, vaultPath, stamps, scheduleSave]);

  // 卸载时把待写的快照冲掉，别把刚建好的索引丢了
  useEffect(
    () => () => {
      if (saveTimer.current !== undefined) {
        window.clearTimeout(saveTimer.current);
        void saveIndexCache(io, vaultPath, mapRef.current);
      }
    },
    [io, vaultPath]
  );

  const touch = useCallback(
    (path: string, content: string) => {
      if (!isIndexable(path)) return;
      const old = mapRef.current.get(path);
      mapRef.current.set(path, {
        path,
        mtime: old?.mtime ?? 0,
        size: content.length,
        content,
      });
      setVersion((v) => v + 1);
      scheduleSave();
    },
    [scheduleSave]
  );

  const rebuild = useCallback(() => {
    mapRef.current = new Map();
    hydratedRef.current = true; // 明确要求重建时不要再吃旧快照
    runRef.current++;
    setReady(false);
    setVersion((v) => v + 1);
  }, []);

  const docs = useMemo(
    () => [...mapRef.current.values()].map((e) => ({ path: e.path, content: e.content })),
    // version 是索引变更的唯一信号（内容在 ref 里，不参与依赖比较）
    [version]
  );

  return { docs, ready, touch, rebuild };
}

/**
 * 本机文件历史——写盘前的快照（v0.11.24）。
 *
 * 用户原话：「如果不小心在其中一端误删了或者误修改了文件然后又全端同步了……
 * 被误修改的可真就无法找回了，有好的 git 或者备份方案吗？」
 *
 * # 两层，各管一半
 *
 * - **云端版本**（lib/api 的 `history()`）：每次同步推上去的每一版都在服务端，
 *   跨设备、永不丢；但要登录，而且只有推上去过的才算。
 * - **本机快照**（本文件）：不登录也有；覆盖"还没来得及同步就改坏了"这一段。
 *   两层在历史面板里合成一条时间线（ui/HistoryPane）。
 *
 * # 快照的是"覆盖之前盘上的内容"，不是"刚写下的内容"
 *
 * Obsidian 的 File Recovery 是定时把当前内容存一份。那样的话，打开一篇笔记、
 * 第一下就删错一段，0.8 秒后自动落盘——第一张快照已经是删错以后的样子，
 * 删错**之前**的那一版谁也没存。所以这里在**写盘之前**读一次盘上的旧内容、
 * 把它存起来，再覆盖：每一张快照都是曾经真实存在于磁盘上的一个状态。
 *
 * # 节流与清理
 *
 * 敲一个字就存一张会把库塞满（也会让 listMeta 对每张快照 stat 一次）。
 * 同一篇 5 分钟内只存一张；超过 30 天或超过 50 张的从最旧开始删。
 * 快照住在 `.ivyea/history/`——它是本机派生数据，不进同步、不进文件树、不进索引
 * （`.ivyea/` 三处都早已排除）。
 */
import type { FileIO } from './sync';

export const HISTORY_DIR = '.ivyea/history/';
/** 同一篇两张快照之间至少隔这么久 */
export const SNAPSHOT_MIN_GAP_MS = 5 * 60 * 1000;
/** 快照保留期 */
export const SNAPSHOT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** 每篇最多留多少张 */
export const SNAPSHOT_MAX_COUNT = 50;

export interface Snapshot {
  /** 快照文件的库内路径（`.ivyea/history/…`） */
  file: string;
  /** 所属笔记的库内路径 */
  note: string;
  /** 快照时刻（毫秒） */
  at: number;
}

/** 笔记路径 → 目录名。与回收站同一套编码（`/` → `__`），看得懂也能反解 */
function encodeNote(note: string): string {
  return note.replaceAll('/', '__');
}

/** 2026-09-11T10-51-37-123 —— 带毫秒，同一秒内两张也不撞名 */
function stampOf(ms: number): string {
  return new Date(ms).toISOString().replace(/[:.]/g, '-').slice(0, 23);
}

const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})(\.[^./]+)?$/;

/** 扩展名（含点），没有就空串 */
function extOf(path: string): string {
  const base = path.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot) : '';
}

export function snapshotPathFor(note: string, atMs: number): string {
  return `${HISTORY_DIR}${encodeNote(note)}/${stampOf(atMs)}${extOf(note)}`;
}

/** 反解快照路径；不是快照就 null */
export function parseSnapshotPath(file: string): Snapshot | null {
  if (!file.startsWith(HISTORY_DIR)) return null;
  const rest = file.slice(HISTORY_DIR.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const dir = rest.slice(0, slash);
  const name = rest.slice(slash + 1);
  const m = STAMP_RE.exec(name);
  if (!m) return null;
  const at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
  if (Number.isNaN(at)) return null;
  return { file, note: dir.replaceAll('__', '/'), at };
}

/** 某篇笔记的全部快照，新的在前 */
export function listSnapshots(allFiles: readonly string[], note: string): Snapshot[] {
  const prefix = `${HISTORY_DIR}${encodeNote(note)}/`;
  const out: Snapshot[] = [];
  for (const f of allFiles) {
    if (!f.startsWith(prefix)) continue;
    const s = parseSnapshotPath(f);
    if (s) out.push(s);
  }
  return out.sort((a, b) => b.at - a.at);
}

/** 该不该存：这篇最近一张离现在够久了才存 */
export function shouldSnapshot(snaps: readonly Snapshot[], nowMs: number, minGapMs = SNAPSHOT_MIN_GAP_MS): boolean {
  const latest = snaps[0];
  return !latest || nowMs - latest.at >= minGapMs;
}

/** 该删哪些：太老的、以及超过张数上限的（从最旧删起）。入参须新的在前 */
export function pruneList(
  snaps: readonly Snapshot[],
  nowMs: number,
  opts: { maxAgeMs?: number; maxCount?: number } = {}
): string[] {
  const maxAge = opts.maxAgeMs ?? SNAPSHOT_MAX_AGE_MS;
  const maxCount = opts.maxCount ?? SNAPSHOT_MAX_COUNT;
  const out: string[] = [];
  snaps.forEach((s, i) => {
    if (i >= maxCount || nowMs - s.at > maxAge) out.push(s.file);
  });
  return out;
}

export interface SnapshotResult {
  /** 新存的快照路径；没存（节流 / 无旧内容 / 内容没变）就 null */
  written: string | null;
  /** 顺手清掉的旧快照 */
  removed: string[];
}

/**
 * 在覆盖 `note` 之前，把它**现在盘上的内容**存一张快照。
 *
 * `allFiles` 是调用方手里现成的全量列表（避免每次再 list 一遍库）；
 * `previous` 是盘上旧内容，读不到（新文件）就不存。内容和最近一张一样也不存——
 * 那只会占地方，恢复时两张一模一样还让人以为哪里不对。
 */
export async function snapshotBeforeWrite(
  io: FileIO,
  vaultPath: string,
  note: string,
  previous: string | null,
  allFiles: readonly string[],
  nowMs = Date.now(),
  opts: { force?: boolean } = {}
): Promise<SnapshotResult> {
  const result: SnapshotResult = { written: null, removed: [] };
  if (previous === null || previous === '') return result;
  const snaps = listSnapshots(allFiles, note);
  // force：恢复旧版之前必须给"现在这版"留底，不能被 5 分钟节流吃掉——否则恢复错了没路回头
  if (!opts.force && !shouldSnapshot(snaps, nowMs)) return result;
  if (snaps[0]) {
    try {
      if ((await io.read(vaultPath, snaps[0].file)) === previous) return result;
    } catch {
      // 最近一张读不到就当没有，照常存
    }
  }
  const file = snapshotPathFor(note, nowMs);
  await io.write(vaultPath, file, previous);
  result.written = file;
  for (const old of pruneList([{ file, note, at: nowMs }, ...snaps], nowMs)) {
    try {
      await io.remove(vaultPath, old);
      result.removed.push(old);
    } catch {
      // 删不掉的旧快照下次再试；不能因为它挡住这次写盘
    }
  }
  return result;
}

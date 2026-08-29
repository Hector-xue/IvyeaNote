/**
 * 每文件同步状态（方案 §5 P4.3，v0.9.2）。
 *
 * 做这个的直接理由是刚踩过的四个 P0：登录后白屏、云端库没绑路径、推送不传 blob、
 * 拉下来不刷新——**四个全是静默失败**。其中「同步成功、↑0、笔记永远上不去」
 * 藏了七个版本，如果当时能看见「这 3 篇一直停在待推送」，第一天就该发现。
 *
 * 所以这里的判定只依赖已经存在的三样东西，不引入新的持久化状态：
 * - 本地文件与内容
 * - `meta.versions`：每条路径最后一次确认的服务端版本号
 * - `meta.bases`：每条路径最后一次同步成功的全文（3-way 合并的共同祖先）
 *
 * 「本地内容 ≠ base」就是**还没推上去**，不管同步报告说了什么。
 */
import type { VaultMeta } from './store';

export type FileSyncState =
  /** 本地内容与最后一次同步成功的内容一致 */
  | 'synced'
  /** 服务端还没有这条路径 —— 从没成功推上去过 */
  | 'new'
  /** 服务端有旧版本，本地改过还没推上去 */
  | 'modified'
  /** 冲突副本（.conflict-<时间戳>.md），等人裁决 */
  | 'conflict'
  /** 本地已删，删除意图还没推上去 */
  | 'deleted';

export interface FileSyncStatus {
  path: string;
  state: FileSyncState;
  /** 服务端版本号；从没同步过则为 undefined */
  version?: number;
}

/**
 * 冲突副本的命名：`原名.conflict-<时间戳>.md`。
 * 时间戳由 sync.ts 用 `toISOString().replace(/[:.]/g,'-').slice(0,19)` 生成，
 * 形如 `2026-08-29T10-30-00`（毫秒和 Z 被 slice 掉了）。
 */
const CONFLICT_SUFFIX = /\.conflict-\d{4}-\d{2}-\d{2}T[\d-]+\.md$/i;

export function isConflictCopy(path: string): boolean {
  return CONFLICT_SUFFIX.test(path);
}

/**
 * 从冲突副本反解原路径。
 *
 * ⚠️ **`.md` 必须补回来**。App.tsx 里原来那份写的是 `.replace(SUFFIX, '')`，
 * 而 SUFFIX 把结尾的 `.md` 也吃进去了，于是 `a.conflict-….md` 反解成 `a`——
 * 「采用副本」会把内容写进一个**没有扩展名的新文件**，原来的 `a.md` 原封不动。
 * 用户以为冲突解决了，实际笔记还是旧内容、目录里还多出一个垃圾文件。
 */
export function originalOfConflict(path: string): string {
  return path.replace(CONFLICT_SUFFIX, '.md');
}

/**
 * 算出一个库里每条路径的状态。
 *
 * @param contents 本地现存的 path → 全文
 * @param meta     该库的同步元信息
 */
export function classifyVault(
  contents: ReadonlyMap<string, string>,
  meta: Pick<VaultMeta, 'versions' | 'bases' | 'tombstones'>
): FileSyncStatus[] {
  const out: FileSyncStatus[] = [];
  for (const [path, content] of contents) {
    const version = meta.versions[path];
    if (isConflictCopy(path)) {
      out.push({ path, state: 'conflict', version });
      continue;
    }
    if (version === undefined) {
      out.push({ path, state: 'new' });
      continue;
    }
    out.push({
      path,
      state: content === (meta.bases[path] ?? '') ? 'synced' : 'modified',
      version,
    });
  }
  // 本地已经没了、但服务端还有的：删除意图待推送。
  // 墓碑记着的那些是「已经推过删除」，不该再算待办，否则面板永远清不空。
  for (const [path, ver] of Object.entries(meta.versions)) {
    if (contents.has(path)) continue;
    if (meta.tombstones?.[path] === ver) continue;
    out.push({ path, state: 'deleted', version: ver });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'));
}

export interface SyncSummary {
  synced: number;
  /** 待推送 = 新增 + 改过 + 待删 */
  pending: number;
  conflict: number;
  total: number;
}

export function summarize(list: readonly FileSyncStatus[]): SyncSummary {
  const s: SyncSummary = { synced: 0, pending: 0, conflict: 0, total: list.length };
  for (const f of list) {
    if (f.state === 'synced') s.synced++;
    else if (f.state === 'conflict') s.conflict++;
    else s.pending++;
  }
  return s;
}

/** 状态 → 给人看的一句话。面板与徽标共用，免得两处措辞不一致 */
export const STATE_LABEL: Record<FileSyncState, string> = {
  synced: '已同步',
  new: '待推送（新增）',
  modified: '待推送（已修改）',
  conflict: '冲突待裁决',
  deleted: '待推送（已删除）',
};

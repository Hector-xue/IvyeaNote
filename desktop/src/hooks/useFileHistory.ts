/**
 * 文件历史（v0.11.24）：本机快照 + 云端版本，合成一条时间线。
 *
 * 用户原话：「如果不小心在其中一端误删了或者误修改了文件然后又全端同步了……
 * 被误修改的可真就无法找回了，有好的 git 或者备份方案吗？」
 *
 * 答案分两层（各自的道理见 lib/history 文件头）：
 * - 云端：服务端从第一天起就把每次 push 的每一版都留着，这里只是把它们**列出来**；
 * - 本机：写盘前把盘上旧内容存一张快照，不登录也有。
 *
 * 这个 hook 只做三件事：写盘前快照（给 App 的 onEdit 用）、按路径拉时间线
 * （给右栏「历史」标签用）、按条目取回内容。**恢复**不在这里——恢复就是一次普通的
 * 写盘 + 编辑器回灌 + 同步，那条链在 App 里本来就有，不该再长一条平行的。
 */
import { useCallback, useMemo, useRef } from 'react';
import type { FileIO } from '../lib/sync';
import type { SyncClient } from '../lib/api';
import { listSnapshots, snapshotBeforeWrite, type Snapshot } from '../lib/history';

export interface HistoryEntry {
  id: string;
  /** 本机快照 / 云端版本 */
  kind: 'local' | 'cloud';
  /** 毫秒 */
  at: number;
  size?: number;
  /** 云端：版本号 */
  version?: number;
  /** 云端：这一版是不是这台设备推上去的 */
  mine?: boolean;
  /** 云端：那一版是"删除"（没有内容可恢复，只是时间线上的一个事件） */
  deleted?: boolean;
  /** 取这一版的全文 */
  load(): Promise<string>;
}

export interface FileHistory {
  /** 写盘前调用：把盘上旧内容存一张快照（按 5 分钟节流；`force` 跳过节流，恢复前用） */
  snapshotBefore(path: string, force?: boolean): Promise<void>;
  /** 某路径的时间线，新的在前。云端那半边失败时只给本机的，并把原因放进 `error` */
  entries(path: string): Promise<{ entries: HistoryEntry[]; error: string | null }>;
  /** 有没有云端那一层（未登录 / 本地库 = 没有） */
  cloud: boolean;
}

export interface FileHistoryDeps {
  io: FileIO;
  vaultPath: string | null;
  /** 云端库 id；本地库（负数）或未登录时不查云端 */
  vaultId: number | null;
  client: SyncClient | null;
  deviceId: string | undefined;
  /** 库内全部已知路径（含 `.ivyea/`），来自 useVaultFiles.allPaths */
  allPaths(): string[];
}

export function useFileHistory(deps: FileHistoryDeps): FileHistory {
  const { io, vaultPath, vaultId, client, deviceId, allPaths } = deps;
  /*
   * allPaths 只在 refresh() 之后才更新，而快照写进去并不触发 refresh
   * （`.ivyea/` 本来就不在树里）。为了让节流判断看得见自己刚写的那张，
   * 这里记一份"本轮会话里写过 / 删过的快照"，和列表合起来用。
   */
  const written = useRef<Set<string>>(new Set());
  const removed = useRef<Set<string>>(new Set());

  const known = useCallback((): string[] => {
    const all = new Set(allPaths());
    for (const w of written.current) all.add(w);
    for (const r of removed.current) all.delete(r);
    return [...all];
  }, [allPaths]);

  const cloud = client !== null && vaultId !== null && vaultId > 0;

  const snapshotBefore = useCallback(
    async (path: string, force = false) => {
      if (vaultPath === null) return;
      try {
        let previous: string | null = null;
        try {
          previous = await io.read(vaultPath, path);
        } catch {
          previous = null; // 新文件，没有旧内容可存
        }
        const r = await snapshotBeforeWrite(io, vaultPath, path, previous, known(), Date.now(), { force });
        if (r.written) written.current.add(r.written);
        for (const x of r.removed) removed.current.add(x);
      } catch (e) {
        // 快照是保险，不是主流程；它失败绝不能挡住写盘。但要留痕，别静默。
        console.warn('文件历史快照失败', path, e);
      }
    },
    [io, vaultPath, known]
  );

  const entries = useCallback(
    async (path: string) => {
      const out: HistoryEntry[] = [];
      let error: string | null = null;
      if (vaultPath !== null) {
        const root = vaultPath;
        for (const s of listSnapshots(known(), path) as Snapshot[]) {
          out.push({
            id: `local:${s.file}`,
            kind: 'local',
            at: s.at,
            load: () => io.read(root, s.file),
          });
        }
      }
      if (cloud && client && vaultId !== null) {
        try {
          const { versions } = await client.history(vaultId, path);
          for (const v of versions) {
            const hash = v.blob_hash;
            out.push({
              id: `cloud:${v.version}`,
              kind: 'cloud',
              at: Date.parse(v.created_at),
              size: v.size,
              version: v.version,
              mine: !!deviceId && v.device_id === deviceId,
              deleted: v.op === 'delete',
              load: async () => {
                if (!hash) return '';
                return new TextDecoder().decode(await client.getBlob(hash));
              },
            });
          }
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
      }
      out.sort((a, b) => b.at - a.at);
      return { entries: out, error };
    },
    [io, vaultPath, known, cloud, client, vaultId, deviceId]
  );

  return useMemo(() => ({ snapshotBefore, entries, cloud }), [snapshotBefore, entries, cloud]);
}

/**
 * 同步引擎的 UI 侧封装（从 App.tsx 抽出，v0.7.8）。
 *
 * 原来是三个几乎一模一样的函数（doSync / doUpload / doDownload），
 * 重入保护、状态置位、错误落报告、finally 复位全是复制粘贴——
 * 改一处忘另一处只是时间问题。这里收成一个 `run(mode)`，三个入口只差一个枚举。
 *
 * 真正的合并算法在 `lib/sync.ts`（3-way diff3），本 hook 只管：
 * 谁在同步、结果怎么呈现、拉取之后要重读哪些东西。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { pullOnly, pushOnly, syncVault, type FileIO, type SyncReport } from '../lib/sync';
import type { SyncClient } from '../lib/api';
import type { VaultMeta } from '../lib/store';

export type SyncMode = 'full' | 'push' | 'pull';

const RUNNERS = { full: syncVault, push: pushOnly, pull: pullOnly } as const;

export interface SyncEngineDeps {
  /** null = 未登录，本地模式。所有同步入口安全地什么也不做 */
  client: SyncClient | null;
  vault: VaultMeta | null;
  io: FileIO;
  /** 设备 id；取不到就不同步（而不是像原来那样 `account!` 硬断言） */
  deviceId: string | undefined;
  /** 同步完必须刷新文件列表——它是索引/侧栏/搜索的共同上游 */
  refresh(): Promise<void>;
  /** 把游标等状态落盘 */
  persist(): void;
  /** 拉取之后的额外动作：远端可能改了当前打开的那篇，要重读 */
  afterPull(): Promise<void>;
  errText(e: unknown): string;
  /**
   * 服务端不认当前这个库时的自愈动作：把它接回云端，接上了返回 true。
   *
   * 没有这条，403「vault 不存在或不属于你」就是个**死循环**——每 60 秒重试一次、
   * 每次都失败，而唯一的出路（重新协调 vault 列表）此前只在登录那一刻跑。
   */
  onUnlinked?(): Promise<boolean>;
  /**
   * 登录态过期时的回调。重试没有意义，只能让用户重新登录——
   * 调用方要据此停掉自动同步并把「重新登录」这个入口摆到明面上。
   */
  onAuthExpired?(): void;
}

export interface SyncEngine {
  syncing: boolean;
  lastReport: SyncReport | null;
  setLastReport: React.Dispatch<React.SetStateAction<SyncReport | null>>;
  /** 推 + 拉 */
  sync(): Promise<void>;
  /** 只推 */
  upload(): Promise<void>;
  /** 只拉 */
  download(): Promise<void>;
}

export function useSyncEngine(deps: SyncEngineDeps): SyncEngine {
  const { client, vault, io, deviceId, refresh, persist, afterPull, errText, onUnlinked, onAuthExpired } =
    deps;
  const [syncing, setSyncing] = useState(false);
  const [lastReport, setLastReport] = useState<SyncReport | null>(null);
  /** 重入保护用 ref 不用 state：并发触发点很多（启动 / 聚焦 / 轮询 / 编辑落盘 / WS 通知），
   *  等 state 更新那一拍已经来不及了 */
  const running = useRef(false);
  /** 一轮同步最多触发一次重接，接上了就清零（换账号/换库之后还能再来一次） */
  const relinked = useRef(false);
  /** 重接成功后要用**新的** vault/io 再同步一次；改 state 让 effect 带着新闭包去跑 */
  const [resyncAt, setResyncAt] = useState(0);

  const run = useCallback(
    async (mode: SyncMode) => {
      if (!client || !vault || !deviceId || running.current) return;
      running.current = true;
      setSyncing(true);
      try {
        const report = await RUNNERS[mode](client, vault, io, deviceId, vault.localPath ?? '');
        setLastReport(report);
        if (report.authExpired) onAuthExpired?.();
        if (report.unlinked && onUnlinked && !relinked.current) {
          relinked.current = true;
          // 接回来之后不能拿这里的 vault/io 重推：它们是**接之前**那个库的闭包。
          // 让 App 落盘新 meta、重渲染，再由下面的 effect 用新闭包同步一次。
          if (await onUnlinked()) setResyncAt(Date.now());
          // 没接上（多半是这会儿连不上服务器）：把闸门放回去，下一轮还能再试，
          // 否则一次失败就把自愈这条路锁死到重启为止
          else relinked.current = false;
        } else if (!report.unlinked) {
          relinked.current = false;
        }
        await refresh();
        // 只在【显式拉取】时重读当前文件，保持与重构前一致。
        // full 模式也会拉到远端改动，理论上当前文件同样可能过期；但用户正在打字时
        // 用磁盘内容盖掉编辑器里的 doc，有丢按键的风险。重构里不改行为——
        // 这个取舍留给「同步状态面板」那批（方案 v2 P4.3）一起处理。
        if (mode === 'pull') await afterPull();
        persist();
      } catch (e) {
        // 失败也要出一份报告：静默失败会让用户以为同步成功了
        setLastReport({
          pushed: 0,
          pulled: 0,
          merged: 0,
          conflicts: [],
          errors: [errText(e)],
        });
      } finally {
        running.current = false;
        setSyncing(false);
      }
    },
    [client, vault, io, deviceId, refresh, persist, afterPull, errText, onUnlinked, onAuthExpired]
  );

  // 重接成功后补一轮完整同步。依赖只有 resyncAt：effect 执行时 `run` 已经是
  // 重渲染之后的那一份（vault 指向新的云端库、io 指向新的存储）。
  useEffect(() => {
    if (!resyncAt) return;
    void run('full');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resyncAt]);

  const sync = useCallback(() => run('full'), [run]);
  const upload = useCallback(() => run('push'), [run]);
  const download = useCallback(() => run('pull'), [run]);

  return { syncing, lastReport, setLastReport, sync, upload, download };
}

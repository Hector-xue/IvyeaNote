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
import { pullOnly, pushOnly, syncVault, type FileIO, type SyncOptions, type SyncReport } from '../lib/sync';
import { ApiError, type SyncClient } from '../lib/api';
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
  /**
   * 把账本落盘。参数是**这一轮真正改过的那个 VaultMeta 对象**：state 里此时可能已经换成
   * 了另一个对象（启动对齐 relink 曾经克隆），落盘方要把账本从这个对象搬到 state 里那个上。
   */
  persist(used: VaultMeta): void;
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
  /**
   * 推 + 拉，但**是应用自己发起的**（启动 / 切回前台 / 60s 轮询 / 恢复联网）。
   *
   * 与 `sync()` 的唯一区别是「连不上服务器」怎么呈现：没人点过任何按钮，
   * 就不该因为一次网络抖动在正文上方贴一段带三条排查提示的红字——手机上
   * 刚解锁、切回前台、VPN 重连都会撞上它（用户：「偶尔的这个报错是怎么回事」）。
   * 这里把这一类失败压成 `offline` 标记，UI 只留一句「离线」，联网后自己消失。
   * 其它失败（403 / 登录过期 / 服务端拒收）照旧原样报出来。
   */
  autoSync(): Promise<void>;
  /** 只推 */
  upload(): Promise<void>;
  /** 只拉 */
  download(): Promise<void>;
  /**
   * v0.11.25：用户在面板上确认"这些确实是我删的"之后，放行被熔断的批量删除再同步一次。
   * 只放行这一轮：下一轮如果又少了一大批，照样拦。
   */
  syncAllowingDeletes(): Promise<void>;
}

/** `fetch` 压根没发出去（跨域被拦 / 没网 / 服务器没起来）——api.ts 统一包成这个 code */
function isNetworkError(e: unknown): boolean {
  return e instanceof ApiError && e.code === 'network_error';
}

/**
 * 自动同步撞上「连不上服务器」时，把错误文案吞掉、只留 `offline` 标记。
 *
 * 只吞这一类：`unlinked`（403 要重接）、`authExpired`（要重新登录）、服务端拒收
 * 都是**重试不会好**的事，压下去就成了静默失败——这个仓库为静默失败付过四轮返工。
 */
function quiet(report: SyncReport, auto: boolean): SyncReport {
  if (!auto || !report.offline || report.authExpired || report.unlinked) return report;
  return { ...report, errors: [] };
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
    async (mode: SyncMode, auto = false, opts: SyncOptions = {}) => {
      if (!client || !vault || !deviceId || running.current) return;
      /*
       * 浏览器/WebView 已经知道没网时，自动同步连试都不用试：一次必然失败的
       * 请求换来的只有一条红条。手动同步不受这个闸门管——navigator.onLine 只
       * 保证"没网时为 false"，反过来不可靠（连着 WiFi 但出不去也报 true），
       * 用户点了按钮就该真的去试一次。
       */
      if (auto && typeof navigator !== 'undefined' && navigator.onLine === false) {
        setLastReport((prev) => ({
          pushed: 0,
          pulled: 0,
          merged: 0,
          conflicts: [],
          errors: [],
          offline: true,
          // 上一轮的冲突/统计已经没意义了，但别把"登录过期"这种仍然成立的状态抹掉
          authExpired: prev?.authExpired,
        }));
        return;
      }
      running.current = true;
      setSyncing(true);
      try {
        const report = await RUNNERS[mode](client, vault, io, deviceId, vault.localPath ?? '', opts);
        setLastReport(quiet(report, auto));
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
        persist(vault);
      } catch (e) {
        // 失败也要出一份报告：静默失败会让用户以为同步成功了
        setLastReport(
          quiet(
            {
              pushed: 0,
              pulled: 0,
              merged: 0,
              conflicts: [],
              errors: [errText(e)],
              offline: isNetworkError(e),
            },
            auto
          )
        );
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
  const autoSync = useCallback(() => run('full', true), [run]);
  const upload = useCallback(() => run('push'), [run]);
  const download = useCallback(() => run('pull'), [run]);
  const syncAllowingDeletes = useCallback(() => run('full', false, { allowMassDelete: true }), [run]);

  return { syncing, lastReport, setLastReport, sync, autoSync, upload, download, syncAllowingDeletes };
}

/**
 * 应用内更新（从 App.tsx 抽出，v0.7.8）。
 *
 * 抽出来的两个理由：
 * 1. **它和笔记本身毫无关系**，却占了 App.tsx 八十多行、四个 state；
 * 2. 原来的写法有 TDZ 隐患——检测到新版本的 useEffect 里调用了 `applyUpdate` 和
 *    `dismissUpdate`，而这两个 `const` 定义在该 effect 之后，只因为调用发生在
 *    异步 IIFE 里才没炸，并且靠 `eslint-disable-next-line exhaustive-deps` 压着。
 *    抽成 hook 后按依赖顺序排列，不再需要那行 disable。
 *
 * 对外只暴露 `checkNow()`：命令面板和手机抽屉的「检查更新」都用它。
 * 静默检查、弹窗确认、下载安装、忽略此版本，全部在内部闭环。
 */
import { useCallback, useEffect, useState } from 'react';
import { checkForUpdate, installUpdate, openReleasePage, type UpdateInfo } from '../lib/updater';

/** 忽略过的版本号记在这里，之后同版本的静默检查不再打扰 */
const DISMISSED_KEY = 'ivnote.update.dismissed';

export interface UpdaterDeps {
  /** 应用内确认框（不能用 window.confirm：WebView2 里静默返回 null） */
  confirm(opts: {
    title: string;
    description?: string;
    okText?: string;
    cancelText?: string;
  }): Promise<boolean>;
  toast(msg: string, kind?: 'info' | 'ok' | 'error'): void;
  /** 当前版本号，构建时由 vite define 注入 */
  appVersion: string;
  /** 移动端（Android）：更新走跳转下载而非应用内安装 */
  isMobile: boolean;
}

export interface Updater {
  /** 手动检查更新：没有新版本也会提示「已是最新」 */
  checkNow(): void;
  /** 正在下载安装（预留给进度 UI） */
  updating: boolean;
}

export function useUpdater(deps: UpdaterDeps): Updater {
  const { confirm, toast, appVersion, isMobile } = deps;
  const [pending, setPending] = useState<UpdateInfo | null>(null);
  const [updating, setUpdating] = useState(false);

  const dismiss = useCallback((info: UpdateInfo) => {
    localStorage.setItem(DISMISSED_KEY, info.version);
    setPending(null);
  }, []);

  const apply = useCallback(
    async () => {
      if (isMobile) {
        // 安卓没法应用内替换 APK，跳到 Release 页让系统安装器接手
        await openReleasePage();
        return;
      }
      setUpdating(true);
      try {
        toast('正在下载更新…', 'ok');
        await installUpdate(); // 内部会 relaunch，正常不会走到下一行
      } catch {
        setUpdating(false);
        toast('更新失败，可到 GitHub Releases 手动下载', 'error');
      }
    },
    [isMobile, toast]
  );

  const check = useCallback(
    async (silent: boolean) => {
      try {
        const info = await checkForUpdate(appVersion);
        const dismissed = localStorage.getItem(DISMISSED_KEY);
        if (info && !(silent && info.version === dismissed)) {
          setPending(info);
        } else if (!silent) {
          toast(`已是最新版本（v${appVersion}）`, 'ok');
        }
      } catch {
        if (!silent) toast('检查更新失败，请稍后重试或到 GitHub Releases 查看', 'error');
      }
    },
    [appVersion, toast]
  );

  // 启动后延迟 3 秒静默检查一次，避免抢启动带宽和焦点
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    const t = window.setTimeout(() => void check(true), 3000);
    return () => window.clearTimeout(t);
    // 只在挂载时跑一次：check 的依赖变化不该重新触发一次启动检查
  }, [check]);

  // 发现新版本 → 弹确认框
  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    void (async () => {
      const ok = await confirm({
        title: `发现新版本 v${pending.version}`,
        description: isMobile
          ? `当前版本 v${appVersion}。安卓端请在浏览器中下载新 APK 安装。`
          : `当前版本 v${appVersion}。更新将自动下载并重启应用。`,
        okText: isMobile ? '前往下载' : '立即更新',
        cancelText: '忽略此版本',
      });
      if (cancelled) return;
      dismiss(pending);
      if (ok) await apply();
    })();
    return () => {
      cancelled = true;
    };
  }, [pending, confirm, isMobile, appVersion, dismiss, apply]);

  const checkNow = useCallback(() => {
    void check(false);
  }, [check]);

  return { checkNow, updating };
}

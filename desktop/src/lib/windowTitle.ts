/**
 * 自绘标题栏要显示的副标题（v0.11.1）。
 *
 * 为什么要这么一个小 store：`WindowChrome` 挂在 `main.tsx` 的 `<App/>` **之外**
 * ——它必须永远在（登录页、欢迎页、空库壳子都得能关窗口），而 App 是一串
 * early-return 分支，把它塞进每一支都要复制一遍，漏一支那一屏就没有关闭按钮。
 * 于是标题栏拿不到「现在开着哪一篇」。
 *
 * 用 `useSyncExternalStore` 而不是 CustomEvent：后者在两个订阅者时容易漏订阅/漏清理，
 * 而这里的语义就是"一个全局值 + 谁需要谁订阅"，标准库里正好有这个东西。
 */
import { useSyncExternalStore } from 'react';

let current = '';
const subs = new Set<() => void>();

/** 由 App 在当前笔记变化时调用 */
export function setWindowSubtitle(next: string): void {
  const v = next ?? '';
  if (v === current) return;
  current = v;
  for (const f of subs) f();
}

/** 订阅变化。导出是为了可测——组件侧走下面那个 hook */
export function subscribeWindowSubtitle(cb: () => void): () => void {
  return subscribe(cb);
}

/** 当前值。导出同样是为了可测 */
export function getWindowSubtitle(): string {
  return current;
}

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

function getSnapshot(): string {
  return current;
}

export function useWindowSubtitle(): string {
  // 服务端快照给同一个值：这个应用没有 SSR，但 useSyncExternalStore 要求第三个参数
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

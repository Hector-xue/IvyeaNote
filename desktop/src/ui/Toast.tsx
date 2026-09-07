/**
 * 轻量 Toast（v0.3.3 新增）：替代 window.alert。
 * alert 在安卓 WebView 里体验割裂、且会阻塞 JS；Toast 不打断操作，3.2 秒自动消失。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type ToastKind = 'info' | 'ok' | 'error';

interface ToastItem {
  id: number;
  msg: string;
  kind: ToastKind;
}

export function useToast() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const toast = useCallback((msg: string, kind: ToastKind = 'info') => {
    seq.current += 1;
    const id = seq.current;
    // 最多同屏 3 条，旧的先走
    setItems((cur) => [...cur.slice(-2), { id, msg, kind }]);
    window.setTimeout(() => {
      setItems((cur) => cur.filter((t) => t.id !== id));
    }, 3200);
  }, []);

  /*
   * v0.11.0：全局事件入口。
   *
   * 编辑器内部（右键菜单的剪贴板操作、图片解析失败）也需要说话，而它离 App
   * 隔着 MainView/MobileView 两层，为一句提示把 toast 一路透传下去只会让
   * 这两个组件的 props 再长一截。这里挂一个窗口级监听，谁都能 `raiseToast()`。
   * 只有 App 调 useToast，所以不会出现同一条弹三遍。
   */
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ msg: string; kind?: ToastKind }>).detail;
      if (d?.msg) toast(d.msg, d.kind ?? 'info');
    };
    window.addEventListener('ivnote-toast', on);
    return () => window.removeEventListener('ivnote-toast', on);
  }, [toast]);

  const toastEl =
    items.length > 0 ? (
      <div className="toast-host">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} role="status">
            {t.msg}
          </div>
        ))}
      </div>
    ) : null;

  return { toast, toastEl };
}

/** 在任何地方弹一条 toast（由 useToast 的窗口级监听接住） */
export function raiseToast(msg: string, kind: ToastKind = 'info'): void {
  window.dispatchEvent(new CustomEvent('ivnote-toast', { detail: { msg, kind } }));
}

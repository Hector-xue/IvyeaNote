/**
 * 轻量 Toast（v0.3.3 新增）：替代 window.alert。
 * alert 在安卓 WebView 里体验割裂、且会阻塞 JS；Toast 不打断操作，3.2 秒自动消失。
 */
import { useCallback, useRef, useState } from 'react';

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

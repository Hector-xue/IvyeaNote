// WebSocket 实时通知：收到 {event:"dirty"} 立即触发一轮同步。
// 断线指数退避 1s→2s→…→60s 封顶；连接成功后重置。协议见 shared/protocol.md §3.5。

export interface DirtyEvent {
  event: 'dirty';
  vault_id: number;
}

export function connectWS(
  serverUrl: string,
  getToken: () => string,
  onDirty: (vaultId: number) => void,
  onStateChange?: (connected: boolean) => void
): () => void {
  let closed = false;
  let ws: WebSocket | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    if (closed) return;
    const wsUrl = `${serverUrl.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(getToken())}`;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      scheduleRetry();
      return;
    }
    ws.onopen = () => {
      attempt = 0;
      onStateChange?.(true);
    };
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data as string) as Partial<DirtyEvent>;
        if (data.event === 'dirty' && typeof data.vault_id === 'number') {
          onDirty(data.vault_id);
        }
      } catch {
        // 忽略无法解析的消息
      }
    };
    ws.onclose = () => {
      onStateChange?.(false);
      ws = null;
      scheduleRetry();
    };
    ws.onerror = () => {
      // onclose 会跟着触发，这里不重复处理
    };
  };

  const scheduleRetry = () => {
    if (closed) return;
    const delay = Math.min(1000 * 2 ** attempt, 60_000);
    attempt++;
    timer = setTimeout(open, delay);
  };

  open();

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}

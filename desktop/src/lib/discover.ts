/**
 * v0.7.0 H9：局域网发现（客户端）。
 * 广播 UDP "IVYEA-DISCOVER" 到 :9999，收集 1.5 秒内的应答，
 * 返回可连接的服务器 URL 列表。仅桌面 Tauri 环境可用（浏览器无 UDP）。
 */
export interface DiscoveredServer {
  url: string;
  ips: string[];
}

export async function discoverServers(timeoutMs = 1500): Promise<DiscoveredServer[]> {
  // Tauri 环境才有 UDP 能力（经 Rust 侧）；浏览器直接返回空
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (!w.__TAURI_INTERNALS__) return [];
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const found = (await invoke('discover_servers', { timeoutMs })) as {
      url: string;
      ips: string[];
    }[];
    return found ?? [];
  } catch {
    // Rust 侧未实现该 command（旧构建）——静默降级
    return [];
  }
}

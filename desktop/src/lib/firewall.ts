/**
 * Windows 防火墙放行（前端侧，v0.11.0）。Rust 实现见 `src-tauri/src/firewall.rs`。
 *
 * 存在的理由写在 Rust 那边：「电脑插网线、手机连 WiFi 就同步不了」的头号嫌疑是
 * Windows 把有线网络归成「公用网络」，入站全拦。这一层只负责问和补。
 */
export interface FirewallInfo {
  supported: boolean;
  allowed: boolean;
  detail: string;
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function firewallStatus(): Promise<FirewallInfo | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<FirewallInfo>('firewall_status');
  } catch {
    // 旧构建没有这个命令：当作"这里管不了"，而不是报错吓人
    return null;
  }
}

/** 写入放行规则（会弹一次 UAC）。返回 null 表示这个环境不支持 */
export async function fixFirewall(): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('fix_firewall');
}

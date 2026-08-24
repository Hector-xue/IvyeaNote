// 本地持久化：登录态与各 vault 的同步游标/版本表。
// 全部存 localStorage —— 桌面端后续可迁到 Tauri store，接口不变。

export interface Tokens {
  access: string;
  refresh: string;
}

/** 一个 vault 的本地元数据与同步进度 */
export interface VaultMeta {
  id: number;
  name: string;
  /** 绑定的本地文件夹绝对路径（桌面端） */
  localPath?: string;
  /** 服务端变更流游标：已应用到本地的最后一条 seq */
  cursor: number;
  /** path -> 最后一次确认的服务端版本号（base_version） */
  versions: Record<string, number>;
  /** path -> 最后一次同步成功的全文内容（作为 3-way 合并的共同祖先） */
  bases: Record<string, string>;
  /** path -> 已确认删除的服务端版本号（防止本地删除被反复重推） */
  tombstones?: Record<string, number>;
}

export interface Account {
  serverUrl: string;
  email: string;
  userId: number;
  deviceId: string;
  tokens: Tokens;
}

export interface PersistState {
  account?: Account;
  vaults: Record<string, VaultMeta>;
}

const KEY = 'ivnote.desktop.state.v1';

export function loadState(): PersistState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { vaults: {} };
    const parsed = JSON.parse(raw) as PersistState;
    return { account: parsed.account, vaults: parsed.vaults ?? {} };
  } catch {
    return { vaults: {} };
  }
}

export function saveState(s: PersistState): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function clearState(): void {
  localStorage.removeItem(KEY);
}

export function newVaultMeta(id: number, name: string): VaultMeta {
  return { id, name, cursor: 0, versions: {}, bases: {} };
}

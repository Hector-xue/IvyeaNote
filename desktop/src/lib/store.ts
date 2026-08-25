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

/** 只清登录态，保留各 vault 的本地数据与同步进度（退出登录不再丢笔记） */
export function clearAccount(): void {
  const s = loadState();
  delete s.account;
  saveState(s);
}

// ---------- 免登录本地模式（v0.3.1） ----------

/** 本地库固定 id：负数永不与云端自增 id 冲突 */
export const LOCAL_VAULT_ID = -1;
export const LOCAL_VAULT_NAME = '我的笔记';
/** 虚拟路径标记：命中即走 OPFS 适配器（适配器忽略具体路径） */
export const LOCAL_VAULT_PATH = 'opfs://local';

export function isLocalVault(v: VaultMeta): boolean {
  return v.id < 0 || v.localPath === LOCAL_VAULT_PATH;
}

/** 无账号时确保存在可用的本地库（幂等，不覆盖已有同步进度） */
export function ensureLocalVault(cur?: PersistState): PersistState {
  const base = cur ?? loadState();
  if (base.vaults[String(LOCAL_VAULT_ID)]) return base;
  return {
    ...base,
    vaults: {
      ...base.vaults,
      [String(LOCAL_VAULT_ID)]: {
        ...newVaultMeta(LOCAL_VAULT_ID, LOCAL_VAULT_NAME),
        localPath: LOCAL_VAULT_PATH,
      },
    },
  };
}

/** 把免登录本地库的元数据并进云端库（文件内容由 migrateFiles 复制） */
export function mergeLocalIntoCloud(local: VaultMeta, cloud: VaultMeta): VaultMeta {
  const versions = { ...cloud.versions };
  const bases = { ...cloud.bases };
  for (const [p, lv] of Object.entries(local.versions)) {
    if (versions[p] === undefined || lv > versions[p]) {
      versions[p] = lv;
      bases[p] = local.bases[p] ?? '';
    }
  }
  return {
    ...cloud,
    cursor: Math.max(cloud.cursor, local.cursor),
    versions,
    bases,
    tombstones: { ...(cloud.tombstones ?? {}), ...(local.tombstones ?? {}) },
  };
}

export function newVaultMeta(id: number, name: string): VaultMeta {
  return { id, name, cursor: 0, versions: {}, bases: {} };
}

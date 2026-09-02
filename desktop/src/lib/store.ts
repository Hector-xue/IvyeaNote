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
  /**
   * 绑定的本地位置。桌面端是文件夹绝对路径；安卓走 SAF 时是 `content://` 树 URI；
   * `opfs://` 前缀＝应用内部存储（卸载即清空）。
   */
  localPath?: string;
  /**
   * v0.10.4：给人看的位置名。`content://com.android.externalstorage.documents/tree/...`
   * 这种东西摆在设置里等于没说，所以另存一份系统给的显示名。
   */
  localLabel?: string;
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

/**
 * 下一个可用的本地库 id（v0.10.2）。
 *
 * 本地库一律用**负数** id，云端自增 id 永远是正的，两边永不撞车；
 * OPFS 的存储目录是 `vault-<id>`，所以 id 唯一就等于数据互不串门。
 *
 * 免登录时也能建库，是因为「建一个笔记本」这件事跟服务器没有任何关系——
 * 此前 `createVault` 第一句就是「云同步需要登录」，把本地功能拿云端能力挡住了。
 */
export function nextLocalVaultId(vaults: Record<string, VaultMeta>): number {
  let min = 0;
  for (const k of Object.keys(vaults)) {
    const id = Number(k);
    if (Number.isFinite(id) && id < min) min = id;
  }
  return min - 1;
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

/**
 * 新建一个 vault 的本地元信息。
 *
 * **`localPath` 必须有默认值**：同步引擎拿 `vault.localPath ?? ''` 判空，
 * 空串直接报「该 vault 未绑定本地文件夹」并 return——也就是说，只要云端库
 * 的 meta 少了这个字段，**登录之后同步就是死的，而且只在同步报告的角落里
 * 留一行错误，不会有任何弹窗**。此前登录建出来的云端库正是这样（本地库有
 * `opfs://local`，云端库什么都没有）。
 *
 * 默认指向 OPFS 里属于这个库的那块（`opfsVaultRoot` 按 `vault-<id>` 取目录，
 * 登录时的 `migrateFiles` 也正是往那儿搬的）。桌面端用户之后可以「绑定文件夹」
 * 覆盖成磁盘真实路径，那条路不受影响。
 */
export function newVaultMeta(id: number, name: string): VaultMeta {
  return { id, name, cursor: 0, versions: {}, bases: {}, localPath: `opfs://${id}` };
}

/**
 * 把「服务端不认的笔记库」接到云端上。
 *
 * 为什么要单独一个文件：这段协调此前**只**长在 `App.tsx` 的 `finishLogin` 里，
 * 一辈子只在「点登录」那一刻跑一次，而且整段裹在一个 `catch {}` 里。
 * 于是 v0.11.5 那次 CORS 故障（`listVaults` 带 `X-Device-Id`，被预检拦掉）留下了
 * 一个**永久性**的坏状态：account 存下来了，vaults 里却只剩一个负数 id 的本地库。
 * 之后每一轮自动同步都拿这个 id 去 `POST /sync/push`，服务端一律回
 * 403「vault 不存在或不属于你」——**CORS 修好了也不会自己好**，因为协调不会再跑第二次。
 * （2026-09-08 在生产库里核实过：该账号名下 vault 0 个、device 0 个。）
 *
 * 所以这里的规矩是：**同步随时可以发现「这个库服务端不认」，随时把它接回去。**
 * 登录只是众多入口之一。
 */
import type { SyncClient } from './api';
import { migrateFiles, opfsIO } from './fs-adapters';
import {
  LOCAL_VAULT_ID,
  mergeLocalIntoCloud,
  newVaultMeta,
  type PersistState,
  type VaultMeta,
} from './store';

/**
 * 绑了**真实存储**（桌面磁盘绝对路径 / 安卓 SAF 树 URI）。
 * `opfs://` 前缀是应用内部存储的虚拟标记，不算。
 */
export function isBound(v: VaultMeta | undefined | null): boolean {
  return !!v?.localPath && !v.localPath.startsWith('opfs://');
}

export interface LinkResult {
  vaults: Record<string, VaultMeta>;
  /** 接完之后该选中哪个库；null = 一个库都没有 */
  activeId: number | null;
  /** 这一次真的接了哪个库；没有需要接的就是 null（据此决定要不要提示用户） */
  linked: { from: number; to: number; name: string; copied: number } | null;
}

/**
 * 让本地这份 vault 清单和服务端对齐，并把**当前这个服务端不认的库**接上云端。
 *
 * - 本地已有的库**一个都不会丢**（此前登录会把 -2、-3 这些库从 state 里抹掉，
 *   磁盘上的笔记还在、界面上再也找不回来）；
 * - 绑了真实文件夹的库**继承绑定、不搬文件**（此前一律往 OPFS 里复制一份，
 *   等于把用户选的 `E:\obsidian` 悄悄换成应用内部存储）；
 * - 换到另一个服务端库，同步进度（cursor/versions/bases）必须清零——
 *   版本号只在**同一个**服务端库里有意义，带过去会让笔记「看起来已同步」而永不上传。
 */
export async function linkVaults(
  client: SyncClient,
  cur: PersistState,
  preferredId?: number | null
): Promise<LinkResult> {
  const { vaults: remote } = await client.listVaults();
  const known = new Set(remote.map((v) => v.id));

  const vaults: Record<string, VaultMeta> = { ...cur.vaults };
  for (const v of remote) {
    const had = vaults[String(v.id)];
    // 名字以服务端为准；本地已有的同步进度原样保留
    vaults[String(v.id)] = had ? { ...had, name: v.name } : newVaultMeta(v.id, v.name);
  }

  const orphan = pickOrphan(vaults, known, preferredId);
  if (!orphan) {
    return { vaults, activeId: chooseActive(vaults, known, preferredId), linked: null };
  }

  /*
   * 收养还是新建？
   * 「本地从没见过的云端库」＝这台设备第一次登录、笔记在别的设备上——
   * 该并进去而不是再建一个同名空库。一个都没有才新建。
   */
  const host = remote.filter((v) => !cur.vaults[String(v.id)]).sort((a, b) => a.id - b.id)[0];
  const base = host
    ? vaults[String(host.id)]!
    : { ...newVaultMeta((await client.createVault(orphan.name)).id, orphan.name), tombstones: {} };

  const target = await moveInto(orphan, base);
  delete vaults[String(orphan.id)];
  vaults[String(target.meta.id)] = target.meta;

  return {
    vaults,
    activeId: target.meta.id,
    linked: { from: orphan.id, to: target.meta.id, name: target.meta.name, copied: target.copied },
  };
}

/** 把 orphan 的内容与绑定搬进 base（base 一定是个**全新的**云端库） */
async function moveInto(
  orphan: VaultMeta,
  base: VaultMeta
): Promise<{ meta: VaultMeta; copied: number }> {
  /*
   * 本地库（负数 id）从未与任何服务端打过交道，它的进度表天生是空的，
   * 合并等于什么都没发生；**孤儿云端库不一样**——它的 versions/cursor 属于
   * 另一个（已经不存在的）服务端库，带过来会让 pushOnly 判定「和 base 一样，跳过」，
   * 结果是笔记一篇都传不上去，而界面显示同步成功。
   */
  const meta = orphan.id < 0 ? mergeLocalIntoCloud(orphan, base) : base;

  if (isBound(orphan)) {
    // 绑了真实文件夹：云端库直接继承这份绑定，**一个文件都不用搬**
    return {
      meta: { ...meta, localPath: orphan.localPath, localLabel: orphan.localLabel },
      copied: 0,
    };
  }
  // OPFS 按 `vault-<id>` 分目录存，换了 id 就得把笔记搬过去，否则用户眼前会突然空掉
  const copied = await migrateFiles(
    opfsIO(() => orphan),
    '',
    opfsIO(() => meta),
    '',
    orphan.tombstones
  );
  return { meta, copied };
}

/** 挑一个「服务端不认」的库来接；当前选中的库服务端认得就返回 null（什么都别动） */
function pickOrphan(
  vaults: Record<string, VaultMeta>,
  known: Set<number>,
  preferredId?: number | null
): VaultMeta | null {
  if (preferredId != null && known.has(preferredId) && vaults[String(preferredId)]) return null;
  const orphans = Object.values(vaults).filter((v) => !known.has(v.id));
  if (orphans.length === 0) return null;
  return (
    orphans.find((v) => v.id === preferredId) ??
    orphans.find((v) => v.id === LOCAL_VAULT_ID) ??
    orphans.sort((a, b) => b.id - a.id)[0]!
  );
}

function chooseActive(
  vaults: Record<string, VaultMeta>,
  known: Set<number>,
  preferredId?: number | null
): number | null {
  if (preferredId != null && vaults[String(preferredId)]) return preferredId;
  const all = Object.values(vaults);
  const cloud = all.filter((v) => known.has(v.id)).sort((a, b) => a.id - b.id)[0];
  if (cloud) return cloud.id;
  return all.sort((a, b) => b.id - a.id)[0]?.id ?? null;
}

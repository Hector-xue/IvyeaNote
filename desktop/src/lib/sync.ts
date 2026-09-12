// 同步引擎：扫描本地 → 推送增量 → 拉取应用（含 3-way 合并/删改复活/冲突副本）。
// 冲突处理统一在拉取阶段完成：服务端版本单调，pull 能拿到全部需要的信息。

import { ApiError, SyncClient, sha256Hex, uuid, type PushChange, type ServerChange } from './api';
import { merge3, conflictCopy } from './merge';
import type { VaultMeta } from './store';
import { trashPathFor } from './trashPath';
import { snapshotBeforeWrite } from './history';

export interface FileIO {
  /** 递归列出 vault 目录下全部相对路径（只列文本笔记） */
  list(vaultPath: string): Promise<string[]>;
  /** v0.3.4：带元数据的列表（排序用：修改时间/大小） */
  listMeta(vaultPath: string): Promise<FileMeta[]>;
  read(vaultPath: string, relPath: string): Promise<string>;
  write(vaultPath: string, relPath: string, content: string): Promise<void>;
  /** v0.3.4：二进制读写（附件图片 / PDF 预览） */
  readBinary(vaultPath: string, relPath: string): Promise<Uint8Array>;
  writeBinary(vaultPath: string, relPath: string, data: Uint8Array): Promise<void>;
  remove(vaultPath: string, relPath: string): Promise<void>;
  exists(vaultPath: string, relPath: string): Promise<boolean>;
}

/** 文件元数据（v0.3.4：排序与列表展示） */
export interface FileMeta {
  path: string;
  /** 修改时间（毫秒时间戳） */
  mtime: number;
  size: number;
}

export interface SyncReport {
  pushed: number;
  pulled: number;
  merged: number;
  conflicts: string[]; // 生成的冲突副本路径
  errors: string[];
  /**
   * 服务端不认这个 vault（403），或者它压根还是个本地库。
   *
   * 这不是普通错误：重试一万次也还是 403，必须**先把库接回云端**再同步
   * （`lib/vaultLink.ts`）。此前没有这个标记，用户能做的只有反复看着
   * 「推送失败：vault 不存在或不属于你」，而且没有任何一条路能让它自己好。
   */
  unlinked?: boolean;
  /**
   * 登录态过期：access token 401 之后连 refresh 也被服务端拒了。
   *
   * 和 `unlinked` 一样，这不是"重试就好"的错——refresh token 已经不在服务端了
   * （被轮换掉、或是超过 30 天），**唯一的出路是重新登录**。没有这个标记，
   * 用户看到的就是一条永远不会消失的红条：「拉取失败：refresh token 无效或已过期」，
   * 而应用既不提示要重登、也不给入口（2026-09-08 手机端就卡在这里）。
   */
  authExpired?: boolean;
  /**
   * 请求压根没发出去（`fetch` 抛 `TypeError: Failed to fetch`）——网络不通、
   * 服务器没起来、跨域被拦，浏览器不会告诉 JS 是哪一种。
   *
   * 和上面两个一样，它需要被**区别对待**，但方向相反：这是唯一一类"过一会儿
   * 多半自己就好了"的失败。手机上尤其如此——刚解锁、切回前台、VPN 在重连，
   * 而自动同步正好在这些时刻各跑一次。上层据此决定：自动同步撞上它只留一句
   * 「离线」，手动同步才给完整的排查提示（见 hooks/useSyncEngine）。
   */
  offline?: boolean;
  /**
   * v0.11.25：账本换了位置，这一轮按"新设备冷启动"全量重新对账（见 relocateIfMoved）。
   * 上层据此提示"库位置变了，正在把云端内容拉到新位置"，而不是让人对着一堆冲突副本发愣。
   */
  relocated?: { from: string; to: string };
  /**
   * v0.11.25：**删除熔断**。本地一下子少了太多已知文件（目录被挪走 / 授权失效 /
   * 指错了位置），这一轮**没有**推送删除；其它改动照常。要么用户在面板上确认
   * "确实是我删的"（带 `allowMassDelete` 再同步一次），要么去把文件找回来。
   */
  massDelete?: { missing: number; known: number; paths: string[] };
}

/** v0.11.25：一次同步的可选项（目前只有一项：放行被熔断的批量删除） */
export interface SyncOptions {
  /** 用户已确认"这些确实是我删的"：本轮不熔断，照推删除 */
  allowMassDelete?: boolean;
}

const MAX_BATCH = 200;

/**
 * 删除熔断阈值。
 *
 * 一轮里"本地消失的已知文件"数达到 **已知总数的 30% 且至少 10 篇**，或者
 * **全部**（库里本来就 ≥ 3 篇）——这不像是人一篇篇删出来的，更像是目录不见了。
 * Dropbox / Obsidian Sync 都有这道闸，我们此前没有，2026-09-11 整个库被清就是这么来的。
 */
export function isMassDelete(missing: number, known: number): boolean {
  if (missing <= 0 || known <= 0) return false;
  if (missing >= 10 && missing / known >= 0.3) return true;
  return missing === known && known >= 3;
}

/**
 * v0.11.25：**账本必须跟着位置走。**
 *
 * `meta.syncedAt` 记的是这本账（versions / bases / assets / cursor）是在哪个 localPath
 * 上对出来的。位置变了，"本地没有"就不能再推理成"用户删了"——2026-09-11 手机换了
 * 库位置指向一个空目录，引擎照样拿老账本对新目录，一轮把整个库的 delete 推上了云端。
 *
 * 位置不一致时把账本清零、游标归零，当成一台新设备从头回放（协议 C8 场景本来就要求
 * 能收敛）：云端有本地没有 → 落盘；两边都有且不同 → 没有共同祖先就走冲突副本，
 * 不覆盖任何一边；本地有云端没有 → 推上去。**换位置只会让文件变多，不会变少。**
 *
 * 老数据没有 `syncedAt`（升级前的账本）：直接记成当前位置，行为不变——
 * 升级本身不该触发一次全量回放。
 */
/** 账本是不是在别的位置对出来的（还没重置）。老账本没有 syncedAt → 不算 */
export function movedSince(meta: VaultMeta, vaultPath: string): boolean {
  return meta.syncedAt !== undefined && meta.syncedAt !== vaultPath;
}

export function relocateIfMoved(meta: VaultMeta, vaultPath: string, report: SyncReport): boolean {
  if (meta.syncedAt === undefined || meta.syncedAt === vaultPath) {
    meta.syncedAt = vaultPath;
    return false;
  }
  report.relocated = { from: meta.syncedAt, to: vaultPath };
  meta.cursor = 0;
  meta.versions = {};
  meta.bases = {};
  meta.assets = {};
  meta.tombstones = {};
  meta.syncedAt = vaultPath;
  return true;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 「这个库还没接到云端」。
 *
 * 负数 id 是**本地库**，服务端根本没有对应的行——照样发过去只会换回一句
 * 403「vault 不存在或不属于你」。登录状态下出现这种库，唯一的出路是先把它
 * 接到云端（`lib/vaultLink.ts` 的 `linkVaults`），所以这里带上 `unlinked`
 * 让上层去自愈，而不是丢一句用户看不懂的报错就完事。
 */
function notLinkedYet(meta: VaultMeta, report: SyncReport): boolean {
  if (meta.id >= 0) return false;
  report.unlinked = true;
  report.errors.push(`「${meta.name}」还是本地笔记库，正在接入云端…`);
  return true;
}

/** 403 = 服务端不认这个 vault（登录那次没接上 / 库被删了 / 换了账号），要重接 */
function markUnlinked(e: unknown, report: SyncReport): void {
  if (e instanceof ApiError && e.status === 403) report.unlinked = true;
}

/**
 * 401 / refresh_invalid = 登录态过期。
 *
 * `SyncClient.req` 拿到 401 会先自动用 refresh 轮换重试一次；能走到这里说明
 * **连 refresh 都失败了**，再试多少次都一样，只能让用户重新登录。
 */
function markAuthExpired(e: unknown, report: SyncReport): void {
  if (e instanceof ApiError && (e.code === 'refresh_invalid' || e.status === 401)) {
    report.authExpired = true;
  }
}

/**
 * `fetch` 直接抛 = 请求没发出去。`SyncClient.req` 把它统一包成
 * `ApiError(0, 'network_error', …)`，这里只认那一种，别的失败照旧当真错误。
 */
function markOffline(e: unknown, report: SyncReport): void {
  if (e instanceof ApiError && e.code === 'network_error') report.offline = true;
}

function isTextNote(path: string): boolean {
  return path.toLowerCase().endsWith('.md') || path.toLowerCase().endsWith('.markdown');
}

/**
 * v0.11.10：**除笔记以外的文件也要同步**（PDF、图片、`.base`、任何附件）。
 *
 * 在此之前，`list()` 的结果被 `isTextNote` 一刀切掉，同步链路里只有 `.md`。
 * 于是「桌面端把 PDF 放进库里，手机端永远看不到」——不是同步坏了，是它
 * 压根没被列进要同步的东西里。协议这一层本来就是内容寻址的 blob，
 * `PUT/GET /blobs/{hash}` 收发的是字节，与文本无关；缺的只有客户端这一段。
 *
 * 附件不做 3-way 合并（把两份 PDF 逐行合起来只会得到一份坏 PDF）：
 * 同一路径两端都改 → 服务端版本落到原路径，本地那份留成冲突副本，人来裁决。
 */
function isAsset(path: string): boolean {
  return !isTextNote(path);
}

/** 服务端单个 blob 上限 50MB（server/internal/api/server.go maxBlobSize），超了先说清楚 */
const MAX_ASSET_BYTES = 50 << 20;

/**
 * **本机私有目录，一个字节都不许上传。**
 *
 * `io.list()` 故意保留 `.ivyea/` 与 `.trash/`（索引快照要读、回收站面板要读，
 * 界面层再用 `HIDDEN_PREFIXES` 挡掉）。v0.11.10 把"非 .md 也同步"接上之后，
 * 这个"故意保留"直接变成了 `.ivyea/cache/content.json 上传失败 HTTP 401`——
 * 应用自己的索引缓存被当成用户附件推上了云。
 *
 * - `.ivyea/`：派生缓存，随时可重建，还很大，跨设备毫无意义；
 * - `.trash/`：本机回收站。同步它等于"在这台电脑删掉的东西跑到那台电脑的回收站里"。
 */
// v0.11.11 修
const LOCAL_ONLY_PREFIXES = ['.ivyea/', '.trash/'];

function isLocalOnly(path: string): boolean {
  return LOCAL_ONLY_PREFIXES.some((p) => path.startsWith(p));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 远端删除落到本地时：先搬进本机回收站，再从原路径拿掉。
 * `content` 传 null 表示调用方没读过，这里自己读一次。
 */
async function moveToTrash(io: FileIO, vaultPath: string, path: string, content: string | null): Promise<void> {
  try {
    const text = content ?? (await io.read(vaultPath, path));
    await io.write(vaultPath, trashPathFor(path), text);
  } catch {
    // 回收站写不进去不该挡住同步收敛；此前本来就是直接删
  }
  await io.remove(vaultPath, path);
}

/** 冲突副本路径：保留原扩展名（`a.pdf` → `a.conflict-<ts>.pdf`） */
function conflictPathFor(path: string, ts: string, forceMd: boolean): string {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  if (forceMd) {
    return dot > slash && dot > 0 ? `${path.slice(0, dot)}.conflict-${ts}.md` : `${path}.conflict-${ts}.md`;
  }
  return dot > slash && dot > 0
    ? `${path.slice(0, dot)}.conflict-${ts}${path.slice(dot)}`
    : `${path}.conflict-${ts}`;
}

/** 完整同步：先推送本地增量，再拉取远端变更（推送出错时不继续拉取）。 */
export async function syncVault(
  client: SyncClient,
  meta: VaultMeta,
  io: FileIO,
  deviceId: string,
  vaultPath: string,
  opts: SyncOptions = {}
): Promise<SyncReport> {
  /*
   * 位置变了就**先拉后推**：账本清零之后先把云端回放到新位置，本地才知道哪些是
   * 云端已有的；反过来先推会把每个文件都当新文件传一遍 blob，还全部 conflict。
   */
  if (vaultPath && meta.id >= 0 && movedSince(meta, vaultPath)) {
    // 真正的重置发生在 pullOnly 里（它据此进入"只对账最终状态"的回放模式）
    const b = await pullOnly(client, meta, io, deviceId, vaultPath);
    if (b.unlinked || b.authExpired || b.errors.some((e) => e.startsWith('拉取失败：'))) return b;
    const a = await pushOnly(client, meta, io, deviceId, vaultPath, opts);
    return mergeReports(b, a);
  }
  const a = await pushOnly(client, meta, io, deviceId, vaultPath, opts);
  /*
   * **只有"整条链路断了"才停下，单个文件传不上去不算。**
   *
   * 原来是 `if (a.errors.length > 0) return a`：任何一条错误都会跳过拉取。
   * 于是一个 50MB 的附件、一份读不出来的文件，就能让"桌面端改的笔记手机端看不到"
   * ——用户报的正是这个（"连我在桌面端的文档修改手机端都不同步了"）。
   * 推不上去的那几个下一轮还会再试，不该连累其余全部。
   */
  if (a.unlinked || a.authExpired || a.errors.some((e) => e.startsWith('推送失败：'))) return a;
  const b = await pullOnly(client, meta, io, deviceId, vaultPath);
  return mergeReports(a, b);
}

function mergeReports(a: SyncReport, b: SyncReport): SyncReport {
  return {
    pushed: a.pushed + b.pushed,
    pulled: a.pulled + b.pulled,
    merged: a.merged + b.merged,
    conflicts: [...a.conflicts, ...b.conflicts],
    errors: [...a.errors, ...b.errors],
    unlinked: a.unlinked || b.unlinked,
    authExpired: a.authExpired || b.authExpired,
    // 合并报告时漏掉哪个标记，上层就等于没有它——offline 也一样
    offline: a.offline || b.offline,
    relocated: a.relocated ?? b.relocated,
    massDelete: a.massDelete ?? b.massDelete,
  };
}

/** 只上传：扫描本地差异并推送到服务端（不拉取远端变更）。 */
export async function pushOnly(
  client: SyncClient,
  meta: VaultMeta,
  io: FileIO,
  _deviceId: string,
  vaultPath: string,
  opts: SyncOptions = {}
): Promise<SyncReport> {
  const report: SyncReport = { pushed: 0, pulled: 0, merged: 0, conflicts: [], errors: [] };
  if (!vaultPath) {
    report.errors.push('该 vault 未绑定本地文件夹');
    return report;
  }
  if (notLinkedYet(meta, report)) return report;
  // 单独「只推」也可能撞上换位置：账本清零之后本地文件全是"新的"，推上去只会
  // 拿回一堆 conflict（服务端已有更高版本）——不丢东西，下一轮 pull 再收敛。
  relocateIfMoved(meta, vaultPath, report);

  // ---------- 1. 扫描本地差异 ----------
  const allFiles = (await io.list(vaultPath)).filter((p) => !isLocalOnly(p));
  const localFiles = new Set(allFiles.filter(isTextNote));
  /** 库里现有的**全部**文件。删除意图要照着它算，否则附件会被当成"本地已删"反复推删除 */
  const localAll = new Set(allFiles);
  const toPush: PushChange[] = [];
  const pushContents = new Map<string, string>(); // path -> 将要上传的内容
  const pushAssets = new Map<string, string>(); // path -> 将要上传的 blob sha256

  for (const path of localFiles) {
    const content = await io.read(vaultPath, path);
    const known = meta.versions[path] !== undefined;
    const base = meta.bases[path] ?? '';
    if (known && content === base) continue;
    /*
     * **必须先上传 blob 再引用它的 sha256**（协议 §3.3：upsert 必须先传 blob）。
     *
     * 这里曾经是个 P0：`toPush` 只塞了 path/op/base_version，**没有 blob_hash、
     * 也从不上传 blob**——带上传的 `pushUpsert` 只用在冲突合并那条支路上。
     * 真服务端因此把每一条 upsert 都判成 rejected，而下面的循环只统计 accepted、
     * 对 rejected「不处理」，于是表现成「同步成功、↑0、什么也没上去」。
     * 从 v0.2.0 起就这样。
     */
    const bytes = new TextEncoder().encode(content);
    const hash = await sha256HexOf(bytes);
    try {
      await client.putBlob(bytes);
    } catch (e) {
      markOffline(e, report);
      report.errors.push(`${path} 内容上传失败：${msg(e)}`);
      continue; // 这一篇传不上去就别推它的指针，避免服务端指向不存在的 blob
    }
    toPush.push({
      client_change_id: uuid(),
      path,
      op: 'upsert',
      blob_hash: hash,
      base_version: known ? meta.versions[path] : 0,
    });
    pushContents.set(path, content);
  }
  // ---------- 1b. 附件（非 .md）：内容寻址，不合并 ----------
  for (const path of allFiles) {
    if (!isAsset(path)) continue;
    let bytes: Uint8Array;
    try {
      bytes = await io.readBinary(vaultPath, path);
    } catch (e) {
      report.errors.push(`${path} 读取失败：${msg(e)}`);
      continue;
    }
    if (bytes.length > MAX_ASSET_BYTES) {
      report.errors.push(
        `${path} 超过 50MB，服务端不收（当前 ${(bytes.length / 1024 / 1024).toFixed(1)}MB）`
      );
      continue;
    }
    const hash = await sha256HexOf(bytes);
    const known = meta.versions[path] !== undefined;
    if (known && meta.assets?.[path] === hash) continue; // 没动过
    try {
      await client.putBlob(bytes);
    } catch (e) {
      markOffline(e, report);
      report.errors.push(`${path} 上传失败：${msg(e)}`);
      continue;
    }
    toPush.push({
      client_change_id: uuid(),
      path,
      op: 'upsert',
      blob_hash: hash,
      base_version: known ? meta.versions[path] : 0,
    });
    pushAssets.set(path, hash);
  }

  // 本地消失的已知文件 → 删除意图（墓碑已记录的跳过）
  const deletes: PushChange[] = [];
  let known = 0;
  for (const [path, ver] of Object.entries(meta.versions)) {
    if (meta.tombstones?.[path] === ver || isLocalOnly(path)) continue;
    known++;
    if (!localAll.has(path)) {
      deletes.push({ client_change_id: uuid(), path, op: 'delete', base_version: ver });
    }
  }
  /*
   * v0.11.25 删除熔断：一下子少了这么多，不像是人一篇篇删的。**这一轮不推删除**，
   * 其它改动照常；把缺失清单放进报告，让人来判断（面板上两条路：确实是我删的 /
   * 从云端拉回来）。用户确认过就带 allowMassDelete 再来一轮。
   */
  if (!opts.allowMassDelete && isMassDelete(deletes.length, known)) {
    report.massDelete = { missing: deletes.length, known, paths: deletes.map((d) => d.path).sort() };
  } else {
    toPush.push(...deletes);
  }

  // ---------- 2. 分批推送 ----------
  for (let i = 0; i < toPush.length; i += MAX_BATCH) {
    const batch = toPush.slice(i, i + MAX_BATCH);
    try {
      const { results } = await client.push(meta.id, batch);
      for (const r of results) {
        if (r.status === 'accepted') {
          report.pushed++;
          const change = batch.find((c) => c.client_change_id === r.client_change_id)!;
          if (change.op === 'delete') {
            meta.versions[change.path] = r.version!;
            (meta.tombstones ??= {})[change.path] = r.version!;
            delete meta.bases[change.path];
            if (meta.assets) delete meta.assets[change.path];
          } else if (pushAssets.has(change.path)) {
            meta.versions[change.path] = r.version!;
            (meta.assets ??= {})[change.path] = pushAssets.get(change.path)!;
            delete meta.tombstones?.[change.path];
          } else {
            meta.versions[change.path] = r.version!;
            meta.bases[change.path] = pushContents.get(change.path) ?? '';
            delete meta.tombstones?.[change.path];
          }
        }
        else if (r.status === 'rejected') {
          // 以前这里和 conflict 一样被静默吞掉，结果是「推不上去」永远看不见。
          // conflict 确实该留给拉取阶段用服务端内容统一解决；rejected 不是——
          // 它意味着这条请求本身有问题（路径非法 / blob 没传），必须让人看到。
          const change = batch.find((c) => c.client_change_id === r.client_change_id);
          report.errors.push(`${change?.path ?? '?'} 被服务端拒绝：${r.reason ?? '未说明原因'}`);
        }
      }
    } catch (e) {
      markUnlinked(e, report);
      markAuthExpired(e, report);
      markOffline(e, report);
      report.errors.push(`推送失败：${msg(e)}`);
      break;
    }
  }

  return report;
}

/** 只拉取：从服务端游标位置拉取远端变更并应用到本地（不上传本地修改）。 */
export async function pullOnly(
  client: SyncClient,
  meta: VaultMeta,
  io: FileIO,
  deviceId: string,
  vaultPath: string,
  _opts: SyncOptions = {}
): Promise<SyncReport> {
  const report: SyncReport = { pushed: 0, pulled: 0, merged: 0, conflicts: [], errors: [] };
  if (!vaultPath) {
    report.errors.push('该 vault 未绑定本地文件夹');
    return report;
  }
  if (notLinkedYet(meta, report)) return report;
  relocateIfMoved(meta, vaultPath, report);

  /*
   * v0.11.25 换位置后的全量回放**只对账最终状态**：把整条流先收成"每个路径最后一条"，
   * 再逐条应用。逐条回放历史会把中间版本一个个砸到新位置的文件上——一篇后来被删掉的
   * 笔记，回放到它的 v1 时会先和本地同名文件生成一份冲突副本，再回放到 delete。
   * 人看到的是一堆莫名其妙的 `.conflict-` 文件。对账只需要"云端现在是什么"。
   * 这种模式下游标也等应用完再落：中途崩了下次从头再来，不会留一半。
   */
  const replay = report.relocated ? new Map<string, ServerChange>() : null;
  const apply = async (ch: ServerChange) => {
    try {
      await applyRemote(client, meta, io, vaultPath, ch, report);
    } catch (e) {
      markAuthExpired(e, report);
      markOffline(e, report);
      report.errors.push(`应用 ${ch.path} 失败：${msg(e)}`);
    }
  };

  // ---------- 游标拉取 ----------
  let cursor = meta.cursor;
  let fetchFailed = false;
  for (let round = 0; round < 100; round++) {
    let page;
    try {
      page = await client.pullPage(meta.id, cursor);
    } catch (e) {
      markUnlinked(e, report);
      markAuthExpired(e, report);
      markOffline(e, report);
      report.errors.push(`拉取失败：${msg(e)}`);
      fetchFailed = true;
      break;
    }
    for (const ch of page.changes) {
      if (ch.device_id === deviceId) continue; // 自己的写已在本地
      if (replay) replay.set(ch.path, ch);
      else await apply(ch);
    }
    const next = page.next_cursor;
    if (!replay) meta.cursor = next; // 每页落盘，崩溃安全
    if (next === cursor) break;
    cursor = next;
  }
  if (replay && !fetchFailed) {
    for (const ch of replay.values()) await apply(ch);
    meta.cursor = cursor;
  }

  return report;
}

/** 应用一条远端变更（含合并/复活/冲突副本决策） */
async function applyRemote(
  client: SyncClient,
  meta: VaultMeta,
  io: FileIO,
  vaultPath: string,
  ch: ServerChange,
  report: SyncReport
): Promise<void> {
  const knownVer = meta.versions[ch.path];
  if (knownVer !== undefined && ch.version <= knownVer) return; // 过期变更，跳过

  /*
   * 云端已经有的 `.ivyea/` / `.trash/`（v0.11.10 那一版推上去的）不要再落回本地：
   * 拉下来会覆盖这台机器自己的索引缓存，而它和这台机器的库并不对应。
   * 只把游标推过去，当它不存在。
   */
  if (isLocalOnly(ch.path)) {
    meta.versions[ch.path] = ch.version;
    return;
  }

  if (isAsset(ch.path)) {
    await applyRemoteAsset(client, meta, io, vaultPath, ch, report);
    return;
  }

  if (ch.op === 'delete') {
    const exists = await io.exists(vaultPath, ch.path);
    /*
     * v0.11.25：这本账从没见过这条路径（换位置后的全量回放 / 新设备冷启动），
     * 本地却有这个文件——那是**这个位置自己的**文件，不是"上次同步留下的副本"。
     * 一条历史里的 delete 不能把它拿走：留着，记下墓碑版本；下一轮推送会以墓碑
     * 版本为 base 把它作为修改推上去（修改胜出，和删改冲突同一条规矩）。
     */
    if (exists && knownVer === undefined) {
      meta.versions[ch.path] = ch.version;
      (meta.tombstones ??= {})[ch.path] = ch.version;
      return;
    }
    if (exists) {
      const base = meta.bases[ch.path];
      const local = base !== undefined ? await io.read(vaultPath, ch.path) : '';
      const locallyModified = base !== undefined && local !== base;
      if (!locallyModified) {
        // 本地没改过 → 跟随删除。**但先进这台机器自己的回收站**（v0.11.24）：
        // 此前这里是直接 remove——手机上误删一篇，电脑 pull 到之后就物理没了，
        // 回收站只在删除的那台设备上有（用户：「别的端也被同步删了，怎么办」）。
        await moveToTrash(io, vaultPath, ch.path, base !== undefined ? local : null);
      }
      // 本地改过却收到删除 → 修改胜出：保留文件，稍后由下方 upsert 分支逻辑推回去。
      // 这里直接把本地内容当作待推送修改处理：
      if (locallyModified) {
        await pushUpsert(client, meta, ch.path, local, ch.version, report);
        return;
      }
    }
    meta.versions[ch.path] = ch.version;
    (meta.tombstones ??= {})[ch.path] = ch.version;
    delete meta.bases[ch.path];
    return;
  }

  // ---------- op = upsert ----------
  const serverBytes = await client.getBlob(ch.blob_hash!);
  const serverText = new TextDecoder().decode(serverBytes);
  const exists = await io.exists(vaultPath, ch.path);

  if (!exists) {
    if (meta.bases[ch.path] !== undefined) {
      // 我们知道这个文件但本地没有 → 本地曾删除 → 删改冲突：修改胜出（复活）
      report.pulled++;
      await io.write(vaultPath, ch.path, serverText);
      meta.versions[ch.path] = ch.version;
      meta.bases[ch.path] = serverText;
      delete meta.tombstones?.[ch.path];
      await pushUpsert(client, meta, ch.path, serverText, ch.version, report);
      return;
    }
    // 全新文件
    await io.write(vaultPath, ch.path, serverText);
    meta.versions[ch.path] = ch.version;
    meta.bases[ch.path] = serverText;
    delete meta.tombstones?.[ch.path];
    report.pulled++;
    return;
  }

  const local = await io.read(vaultPath, ch.path);
  if (local === serverText) {
    meta.versions[ch.path] = ch.version;
    meta.bases[ch.path] = serverText;
    delete meta.tombstones?.[ch.path];
    return;
  }
  const base = meta.bases[ch.path] ?? '';
  if (local === base) {
    // 本地自上次同步后没动过 → 静默接受服务端版本
    await io.write(vaultPath, ch.path, serverText);
    meta.versions[ch.path] = ch.version;
    meta.bases[ch.path] = serverText;
    delete meta.tombstones?.[ch.path];
    report.pulled++;
    return;
  }

  // 双端都改了 → 3-way 合并
  const r = merge3(base, local, serverText);
  if (r.merged !== null) {
    // 自动合并会改写本地这份；先给它留一张本机快照（v0.11.24 文件历史）——
    // 合并"成功"只是三方没撞行，不等于结果一定是人想要的。
    try {
      await snapshotBeforeWrite(io, vaultPath, ch.path, local, await io.list(vaultPath));
    } catch {
      // 快照失败不挡合并
    }
    await io.write(vaultPath, ch.path, r.merged);
    meta.versions[ch.path] = ch.version;
    meta.bases[ch.path] = r.merged;
    delete meta.tombstones?.[ch.path];
    report.pulled++;
    report.merged++;
    // 合并结果回推服务端
    await pushUpsert(client, meta, ch.path, r.merged, ch.version, report);
  } else {
    // 自动合并失败 → 写冲突副本，本地保留原样，base 前移到服务端版本；
    // 本地与 base 的差异会在下次推送时作为修改提交（最终一致，人工裁决副本）。
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const copyPath = conflictPathFor(ch.path, ts, true);
    await io.write(vaultPath, copyPath, conflictCopy(ch.path, r, ts));
    meta.versions[ch.path] = ch.version;
    meta.bases[ch.path] = serverText;
    delete meta.tombstones?.[ch.path];
    report.conflicts.push(copyPath);
  }
}

/**
 * 应用一条远端**附件**变更（PDF / 图片 / .base / 任何非 .md 文件）。
 *
 * 与文本那条路的唯一区别是"两端都改了"怎么办：文本能 3-way 合并，字节流不能。
 * 这里的规则是**服务端版本落到原路径、本地那份改名留下**——不静默覆盖任何一端
 * （协议第三条原则：冲突必须可见、可选、可回滚）。
 */
async function applyRemoteAsset(
  client: SyncClient,
  meta: VaultMeta,
  io: FileIO,
  vaultPath: string,
  ch: ServerChange,
  report: SyncReport
): Promise<void> {
  const knownHash = meta.assets?.[ch.path];
  const setHash = (h: string) => {
    (meta.assets ??= {})[ch.path] = h;
  };

  if (ch.op === 'delete') {
    if (await io.exists(vaultPath, ch.path)) {
      // 同文本那条路（v0.11.25）：这本账没见过它、本地却有 → 是这个位置自己的文件，留着
      if (knownHash === undefined) {
        meta.versions[ch.path] = ch.version;
        (meta.tombstones ??= {})[ch.path] = ch.version;
        return;
      }
      const local = await io.readBinary(vaultPath, ch.path);
      const localHash = await sha256HexOf(local);
      if (localHash !== knownHash) {
        // 本地改过却收到删除 → 修改胜出，把本地这份推回去
        await pushUpsertBytes(client, meta, ch.path, local, localHash, ch.version, report);
        return;
      }
      // 同文本那条路：远端删的附件也先进本机回收站（v0.11.24）
      try {
        await io.writeBinary(vaultPath, trashPathFor(ch.path), local);
      } catch {
        // 回收站写不进去不该挡住同步收敛；此前本来就是直接删
      }
      await io.remove(vaultPath, ch.path);
    }
    meta.versions[ch.path] = ch.version;
    (meta.tombstones ??= {})[ch.path] = ch.version;
    if (meta.assets) delete meta.assets[ch.path];
    return;
  }

  const serverBytes = new Uint8Array(await client.getBlob(ch.blob_hash!));
  const exists = await io.exists(vaultPath, ch.path);

  if (!exists) {
    await io.writeBinary(vaultPath, ch.path, serverBytes);
    meta.versions[ch.path] = ch.version;
    setHash(ch.blob_hash!);
    delete meta.tombstones?.[ch.path];
    report.pulled++;
    return;
  }

  const local = await io.readBinary(vaultPath, ch.path);
  if (bytesEqual(local, serverBytes)) {
    meta.versions[ch.path] = ch.version;
    setHash(ch.blob_hash!);
    delete meta.tombstones?.[ch.path];
    return;
  }

  const localHash = await sha256HexOf(local);
  if (knownHash === undefined || localHash === knownHash) {
    // 本地自上次同步后没动过 → 接受服务端版本
    await io.writeBinary(vaultPath, ch.path, serverBytes);
    meta.versions[ch.path] = ch.version;
    setHash(ch.blob_hash!);
    delete meta.tombstones?.[ch.path];
    report.pulled++;
    return;
  }

  /*
   * 两端都改了：服务端版本进原路径，本地那份留成冲突副本（保留扩展名，双击还能打开）。
   *
   * 附件的冲突副本**故意不进冲突面板**（`syncStatus.isConflictCopy` 只认 `.md`）：
   * 那个面板的「采用副本」是按文本读写的，拿它去处理一份 PDF 只会写出一个坏文件。
   * 附件的冲突留给人在文件管理器里比对，同步报告里会列出副本路径。
   */
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const copyPath = conflictPathFor(ch.path, ts, false);
  await io.writeBinary(vaultPath, copyPath, local);
  await io.writeBinary(vaultPath, ch.path, serverBytes);
  meta.versions[ch.path] = ch.version;
  setHash(ch.blob_hash!);
  delete meta.tombstones?.[ch.path];
  report.pulled++;
  report.conflicts.push(copyPath);
}

/** 附件版的回推：字节流直传，不经过 TextEncoder */
async function pushUpsertBytes(
  client: SyncClient,
  meta: VaultMeta,
  path: string,
  bytes: Uint8Array,
  hash: string,
  baseVersion: number,
  report: SyncReport
): Promise<void> {
  await client.putBlob(bytes);
  const { results } = await client.push(meta.id, [
    { client_change_id: uuid(), path, op: 'upsert', blob_hash: hash, base_version: baseVersion },
  ]);
  const r = results[0];
  if (r?.status === 'accepted') {
    report.pushed++;
    meta.versions[path] = r.version!;
    (meta.assets ??= {})[path] = hash;
    delete meta.tombstones?.[path];
  } else if (r?.status === 'conflict') {
    report.errors.push(`${path} 回推遇到新冲突，将在下轮同步重试`);
  }
}

async function pushUpsert(
  client: SyncClient,
  meta: VaultMeta,
  path: string,
  content: string,
  baseVersion: number,
  report: SyncReport
): Promise<void> {
  const bytes = new TextEncoder().encode(content);
  const hash = await sha256HexOf(bytes);
  await client.putBlob(bytes);
  const { results } = await client.push(meta.id, [
    { client_change_id: uuid(), path, op: 'upsert', blob_hash: hash, base_version: baseVersion },
  ]);
  const r = results[0];
  if (r?.status === 'accepted') {
    report.pushed++;
    meta.versions[path] = r.version!;
    meta.bases[path] = content;
    delete meta.tombstones?.[path];
  } else if (r?.status === 'conflict') {
    // 极端并发（拉取到推送之间又被别人写）：留待下一轮同步收敛
    report.errors.push(`${path} 合并回推遇到新冲突，将在下轮同步重试`);
  }
}

function sha256HexOf(bytes: Uint8Array): Promise<string> {
  return sha256Hex(bytes);
}

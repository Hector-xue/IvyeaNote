// 同步引擎：扫描本地 → 推送增量 → 拉取应用（含 3-way 合并/删改复活/冲突副本）。
// 冲突处理统一在拉取阶段完成：服务端版本单调，pull 能拿到全部需要的信息。

import { SyncClient, sha256Hex, uuid, type PushChange, type ServerChange } from './api';
import { merge3, conflictCopy } from './merge';
import type { VaultMeta } from './store';

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
}

const MAX_BATCH = 200;

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isTextNote(path: string): boolean {
  return path.toLowerCase().endsWith('.md') || path.toLowerCase().endsWith('.markdown');
}

/** 完整同步：先推送本地增量，再拉取远端变更（推送出错时不继续拉取）。 */
export async function syncVault(
  client: SyncClient,
  meta: VaultMeta,
  io: FileIO,
  deviceId: string,
  vaultPath: string
): Promise<SyncReport> {
  const a = await pushOnly(client, meta, io, deviceId, vaultPath);
  if (a.errors.length > 0) return a;
  const b = await pullOnly(client, meta, io, deviceId, vaultPath);
  return {
    pushed: a.pushed + b.pushed,
    pulled: a.pulled + b.pulled,
    merged: a.merged + b.merged,
    conflicts: [...a.conflicts, ...b.conflicts],
    errors: [...a.errors, ...b.errors],
  };
}

/** 只上传：扫描本地差异并推送到服务端（不拉取远端变更）。 */
export async function pushOnly(
  client: SyncClient,
  meta: VaultMeta,
  io: FileIO,
  _deviceId: string,
  vaultPath: string
): Promise<SyncReport> {
  const report: SyncReport = { pushed: 0, pulled: 0, merged: 0, conflicts: [], errors: [] };
  if (!vaultPath) {
    report.errors.push('该 vault 未绑定本地文件夹');
    return report;
  }

  // ---------- 1. 扫描本地差异 ----------
  const localFiles = new Set((await io.list(vaultPath)).filter(isTextNote));
  const toPush: PushChange[] = [];
  const pushContents = new Map<string, string>(); // path -> 将要上传的内容

  for (const path of localFiles) {
    const content = await io.read(vaultPath, path);
    const known = meta.versions[path] !== undefined;
    const base = meta.bases[path] ?? '';
    if (!known) {
      toPush.push({
        client_change_id: uuid(),
        path,
        op: 'upsert',
        base_version: 0,
      });
      pushContents.set(path, content);
    } else if (content !== base) {
      toPush.push({
        client_change_id: uuid(),
        path,
        op: 'upsert',
        base_version: meta.versions[path],
      });
      pushContents.set(path, content);
    }
  }
  // 本地消失的已知文件 → 删除意图（墓碑已记录的跳过）
  for (const [path, ver] of Object.entries(meta.versions)) {
    if (!localFiles.has(path) && meta.tombstones?.[path] !== ver) {
      toPush.push({ client_change_id: uuid(), path, op: 'delete', base_version: ver });
    }
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
            meta.tombstones = { ...(meta.tombstones ?? {}), [change.path]: r.version! };
            delete meta.bases[change.path];
          } else {
            meta.versions[change.path] = r.version!;
            meta.bases[change.path] = pushContents.get(change.path) ?? '';
            delete meta.tombstones?.[change.path];
          }
        }
        // conflict / rejected：不处理，等拉取阶段用服务端内容统一解决
      }
    } catch (e) {
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
  vaultPath: string
): Promise<SyncReport> {
  const report: SyncReport = { pushed: 0, pulled: 0, merged: 0, conflicts: [], errors: [] };
  if (!vaultPath) {
    report.errors.push('该 vault 未绑定本地文件夹');
    return report;
  }

  // ---------- 游标拉取 ----------
  let cursor = meta.cursor;
  for (let round = 0; round < 100; round++) {
    let page;
    try {
      page = await client.pullPage(meta.id, cursor);
    } catch (e) {
      report.errors.push(`拉取失败：${msg(e)}`);
      break;
    }
    for (const ch of page.changes) {
      if (ch.device_id === deviceId) continue; // 自己的写已在本地
      try {
        await applyRemote(client, meta, io, vaultPath, ch, report);
      } catch (e) {
        report.errors.push(`应用 ${ch.path} 失败：${msg(e)}`);
      }
    }
    const next = page.next_cursor;
    meta.cursor = next; // 每页落盘，崩溃安全
    if (next === cursor) break;
    cursor = next;
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

  if (ch.op === 'delete') {
    const exists = await io.exists(vaultPath, ch.path);
    if (exists) {
      const base = meta.bases[ch.path];
      const local = base !== undefined ? await io.read(vaultPath, ch.path) : '';
      const locallyModified = base !== undefined && local !== base;
      if (!locallyModified) {
        await io.remove(vaultPath, ch.path); // 本地没改过 → 跟随删除
      }
      // 本地改过却收到删除 → 修改胜出：保留文件，稍后由下方 upsert 分支逻辑推回去。
      // 这里直接把本地内容当作待推送修改处理：
      if (locallyModified) {
        await pushUpsert(client, meta, ch.path, local, ch.version, report);
        return;
      }
    }
    meta.versions[ch.path] = ch.version;
    meta.tombstones = { ...(meta.tombstones ?? {}), [ch.path]: ch.version };
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
    const dot = ch.path.lastIndexOf('.');
    const copyPath =
      dot > 0 ? `${ch.path.slice(0, dot)}.conflict-${ts}.md` : `${ch.path}.conflict-${ts}.md`;
    await io.write(vaultPath, copyPath, conflictCopy(ch.path, r, ts));
    meta.versions[ch.path] = ch.version;
    meta.bases[ch.path] = serverText;
    delete meta.tombstones?.[ch.path];
    report.conflicts.push(copyPath);
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

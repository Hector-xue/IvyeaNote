/**
 * v0.11.40：新设备首次同步把云端**早已删除**的历史副本落了一地。
 *
 * 真实事故（2026-10-16，nginx 日志 + 服务端 changes 表对出来的）：云端 obsidian 库的历史里
 * 有 9 月 SAF 事故留下的 183 个 `xxx.md.txt` / `xxx.md (n).txt`，先建后删。新手机从游标 0
 * 逐条重放：第 1 页放完时 138 个处在"建了还没删"，第 2 页刚开头同步就断了，账本也没落盘；
 * 下一轮这些文件成了"账本不认识的本地文件"，被当新附件往云端推（blob 已经传了，差最后一步提交）。
 */
import { describe, expect, it } from 'vitest';
import { syncVault, type FileIO } from './sync';
import { ApiError, SyncClient, sha256Hex, type PushChange, type ServerChange } from './api';
import { newVaultMeta, type VaultMeta } from './store';

function memIO(files: Map<string, string>, failRead?: (p: string) => boolean): FileIO {
  return {
    async list() {
      return [...files.keys()];
    },
    async listMeta() {
      return [...files.keys()].map((p) => ({ path: p, mtime: 0, size: files.get(p)!.length }));
    },
    async read(_vp, rel) {
      if (failRead?.(rel)) throw new Error('SAF 读取失败');
      const v = files.get(rel);
      if (v === undefined) throw new Error(`not found: ${rel}`);
      return v;
    },
    async write(_vp, rel, content) {
      files.set(rel, content);
    },
    async readBinary(_vp, rel) {
      const v = files.get(rel);
      if (v === undefined) throw new Error(`not found: ${rel}`);
      return new TextEncoder().encode(v);
    },
    async writeBinary(_vp, rel, data) {
      files.set(rel, new TextDecoder().decode(data));
    },
    async remove(_vp, rel) {
      files.delete(rel);
    },
    async exists(_vp, rel) {
      return files.has(rel);
    },
  };
}

const NOTE = '# CNC\n加工笔记';

async function h(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}

/** 和事故同形状：正经笔记 + 两份 SAF 改名副本（同内容），后来副本被删 */
async function stream(): Promise<ServerChange[]> {
  const hn = await h(NOTE);
  return [
    { seq: 1, path: 'Ivyea/CNC.md', op: 'upsert', version: 1, device_id: 'desktop', blob_hash: hn },
    { seq: 2, path: 'Ivyea/CNC.md.txt', op: 'upsert', version: 1, device_id: 'old-phone', blob_hash: hn },
    { seq: 3, path: 'Ivyea/CNC.md (1).txt', op: 'upsert', version: 1, device_id: 'old-phone', blob_hash: hn },
    { seq: 4, path: 'Ivyea/CNC.md.txt', op: 'delete', version: 2, device_id: 'admin' },
    { seq: 5, path: 'Ivyea/CNC.md (1).txt', op: 'delete', version: 2, device_id: 'admin' },
  ];
}

/** 迷你服务端：变更流 + 版本冲突判定（与 server/internal/sync 同规则：base 必须等于当前版本） */
function server(changes: ServerChange[], opts: { offlinePullFrom?: number; noHistory?: boolean } = {}) {
  const blobs = new Map<string, Uint8Array>();
  const pushed: PushChange[] = [];
  const head = (path: string) => {
    let last: ServerChange | undefined;
    for (const c of changes) if (c.path === path) last = c;
    return last;
  };
  const client = {
    pullPage: async (_v: number, cursor: number) => {
      if (opts.offlinePullFrom !== undefined && cursor >= opts.offlinePullFrom) {
        throw new ApiError(0, 'network_error', '连不上服务器（Failed to fetch）');
      }
      const page = changes.filter((c) => c.seq > cursor).slice(0, 2);
      return { changes: page.map((c) => ({ ...c })), next_cursor: page.length ? page[page.length - 1].seq : cursor };
    },
    getBlob: async () => {
      return new TextEncoder().encode(NOTE).buffer as ArrayBuffer;
    },
    putBlob: async (bytes: Uint8Array) => {
      blobs.set(await sha256Hex(bytes), bytes);
    },
    push: async (_v: number, batch: PushChange[]) => ({
      results: batch.map((c) => {
        const cur = head(c.path);
        const curVer = cur?.version ?? 0;
        if (c.base_version !== curVer) {
          return {
            client_change_id: c.client_change_id,
            status: 'conflict' as const,
            server_version: curVer,
            server_blob_hash: cur?.op === 'upsert' ? cur.blob_hash : undefined,
          };
        }
        pushed.push(c);
        const seq = changes.length ? changes[changes.length - 1].seq + 1 : 1;
        changes.push({ seq, path: c.path, op: c.op, version: curVer + 1, device_id: 'new-phone', blob_hash: c.blob_hash });
        return { client_change_id: c.client_change_id, status: 'accepted' as const, version: curVer + 1 };
      }),
    }),
    history: async (_v: number, path: string) => {
      if (opts.noHistory) throw new ApiError(404, 'not_found', 'no');
      return {
        versions: changes
          .filter((c) => c.path === path)
          .reverse()
          .map((c) => ({ version: c.version, op: c.op, blob_hash: c.blob_hash, size: 0, device_id: c.device_id, created_at: '' })),
      };
    },
  } as unknown as SyncClient;
  return { client, pushed };
}

function meta(): VaultMeta {
  return { ...newVaultMeta(11, 'obsidian'), localPath: '/vault' };
}

const txt = (files: Map<string, string>) => [...files.keys()].filter((p) => p.endsWith('.txt'));

describe('新设备首次同步：云端历史里先建后删的副本不落盘', () => {
  it('一次走完：一个 .txt 都不写（连回收站里都没有——根本没落过盘）', async () => {
    const files = new Map<string, string>();
    const m = meta();
    const { client } = server(await stream());
    const r = await syncVault(client, m, memIO(files), 'new-phone', '/vault');
    expect(r.errors).toEqual([]);
    expect(files.get('Ivyea/CNC.md')).toBe(NOTE);
    expect(txt(files)).toEqual([]);
    expect(m.cursor).toBe(5);
  });

  it('同步中途断了（事故那样：第 2 页之后再没拉到）：不会留下历史副本', async () => {
    const files = new Map<string, string>();
    const m = meta();
    // 每页 2 条：第 1、2 页拿到了 seq 1~4，「CNC.md (1).txt」的删除在第 3 页
    const { client } = server(await stream(), { offlinePullFrom: 4 });
    await syncVault(client, m, memIO(files), 'new-phone', '/vault');
    expect(txt(files)).toEqual([]);
    expect(m.cursor).toBe(0); // 没拉全就不算数，下一轮整段重来
  });
});

describe('上一轮已经落了一地、账本没落盘（新手机现在的样子）：升级后自愈', () => {
  async function brokenPhone(): Promise<{ files: Map<string, string>; m: VaultMeta }> {
    return {
      m: meta(),
      files: new Map([
        ['Ivyea/CNC.md', NOTE],
        ['Ivyea/CNC.md.txt', NOTE],
        ['Ivyea/CNC.md (1).txt', NOTE],
      ]),
    };
  }

  it('游标 0：先拉后推，残留副本进回收站，一个都不推回云端', async () => {
    const { files, m } = await brokenPhone();
    const { client, pushed } = server(await stream());
    const r = await syncVault(client, m, memIO(files), 'new-phone', '/vault');
    expect(r.errors).toEqual([]);
    expect(txt(files).filter((p) => !p.startsWith('.trash/'))).toEqual([]);
    expect(pushed.filter((c) => c.path.endsWith('.txt'))).toEqual([]);
    expect(files.get('Ivyea/CNC.md')).toBe(NOTE);
  });

  it('游标已过、账本不认识残留：推送撞冲突 → 问服务端历史 → 跟着删，不复活', async () => {
    const { files, m } = await brokenPhone();
    const changes = await stream();
    m.cursor = 5;
    m.syncedAt = '/vault';
    m.versions = { 'Ivyea/CNC.md': 1 };
    m.bases = { 'Ivyea/CNC.md': NOTE };
    m.reconciledAt = Date.now();
    const { client, pushed } = server(changes);
    await syncVault(client, m, memIO(files), 'new-phone', '/vault');
    expect(txt(files).filter((p) => !p.startsWith('.trash/'))).toEqual([]);
    expect(pushed.filter((c) => c.path.endsWith('.txt'))).toEqual([]);
  });

  it('阴性对照：同一路径但内容是这台设备自己写的（云端从没有过）→ 照旧留着并推上去', async () => {
    const { m } = await brokenPhone();
    const files = new Map([
      ['Ivyea/CNC.md', NOTE],
      ['Ivyea/CNC.md.txt', '我自己写的，云端没有过'],
    ]);
    const { client, pushed } = server(await stream());
    await syncVault(client, m, memIO(files), 'new-phone', '/vault');
    expect(files.get('Ivyea/CNC.md.txt')).toBe('我自己写的，云端没有过');
    expect(pushed.some((c) => c.path === 'Ivyea/CNC.md.txt' && c.op === 'upsert')).toBe(true);
  });

  it('服务端查不到历史（老服务端 / 接口失败）→ 不敢删，按老规矩留着', async () => {
    const { files, m } = await brokenPhone();
    m.cursor = 5;
    m.syncedAt = '/vault';
    m.versions = { 'Ivyea/CNC.md': 1 };
    m.bases = { 'Ivyea/CNC.md': NOTE };
    m.reconciledAt = Date.now();
    const { client } = server(await stream(), { noHistory: true });
    await syncVault(client, m, memIO(files), 'new-phone', '/vault');
    expect(files.has('Ivyea/CNC.md.txt')).toBe(true);
  });
});

describe('一篇读不出来不能拖垮整轮', () => {
  it('其它笔记照常推送，错误写进报告而不是整轮抛出', async () => {
    const files = new Map([
      ['a.md', 'A'],
      ['bad.md', 'B'],
    ]);
    const m = meta();
    m.cursor = 5;
    m.syncedAt = '/vault';
    m.reconciledAt = Date.now();
    const { client, pushed } = server(await stream());
    const r = await syncVault(client, m, memIO(files, (p) => p === 'bad.md'), 'new-phone', '/vault');
    expect(pushed.map((c) => c.path)).toContain('a.md');
    expect(r.errors.some((e) => e.includes('bad.md'))).toBe(true);
  });
});

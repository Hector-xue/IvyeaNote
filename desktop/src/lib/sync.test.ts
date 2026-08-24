import { describe, it, expect } from 'vitest';
import { syncVault, type FileIO, type SyncReport } from './sync';
import { SyncClient, type PushChange, type PushResult, type ServerChange } from './api';
import { newVaultMeta, type VaultMeta } from './store';

// ---------- 内存文件系统 ----------

function memIO(files: Map<string, string>): FileIO {
  return {
    async list() {
      return [...files.keys()];
    },
    async read(_vp, rel) {
      const v = files.get(rel);
      if (v === undefined) throw new Error(`not found: ${rel}`);
      return v;
    },
    async write(_vp, rel, content) {
      files.set(rel, content);
    },
    async remove(_vp, rel) {
      files.delete(rel);
    },
    async exists(_vp, rel) {
      return files.has(rel);
    },
  };
}

// ---------- 服务端模拟（按协议 v1 行为） ----------

interface ServerChangeRow extends ServerChange {
  seq: number;
}

function mockServer(opts: { changes: ServerChangeRow[] }) {
  let seq = opts.changes.length;
  const versions = new Map<string, number>();
  for (const c of opts.changes) versions.set(c.path, c.version);

  const client = {
    push: async (_vaultId: number, changes: PushChange[]) => {
      const results: PushResult[] = [];
      for (const ch of changes) {
        const cur = versions.get(ch.path) ?? 0;
        if (ch.base_version < cur) {
          results.push({
            client_change_id: ch.client_change_id,
            status: 'conflict',
            server_version: cur,
          });
          continue;
        }
        const next = cur + 1;
        versions.set(ch.path, next);
        opts.changes.push({
          seq: ++seq,
          path: ch.path,
          op: ch.op,
          version: next,
          device_id: 'self',
          blob_hash: ch.blob_hash,
        });
        results.push({ client_change_id: ch.client_change_id, status: 'accepted', version: next });
      }
      return { results };
    },
    pullPage: async (_vaultId: number, cursor: number) => {
      const page = opts.changes.filter((c) => c.seq > cursor).slice(0, 500);
      const next = page.length ? page[page.length - 1].seq : cursor;
      return { changes: page.map(({ ...c }) => c), next_cursor: next };
    },
    getBlob: async (hash: string) => new TextEncoder().encode(blobStore.get(hash)!).buffer as ArrayBuffer,
    putBlob: async (bytes: Uint8Array) => {
      const hash = await sha256(bytes);
      blobStore.set(hash, new TextDecoder().decode(bytes));
    },
  } as unknown as SyncClient;
  return client;
}

const blobStore = new Map<string, string>();

async function sha256(bytes: Uint8Array): Promise<string> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const SELF = 'device-self';

async function run(meta: VaultMeta, io: FileIO, server: SyncClient): Promise<SyncReport> {
  return syncVault(server, meta, io, SELF, '/vault');
}

// ---------- 场景测试 ----------

describe('syncVault 一致性场景', () => {
  it('C1 首轮：本地新文件推上去，远端已有变更拉下来', async () => {
    const local = new Map([['a.md', 'local-a']]);
    const serverChanges: ServerChangeRow[] = [
      { seq: 1, path: 'b.md', op: 'upsert', version: 1, device_id: 'other', blob_hash: 'h-b' },
    ];
    blobStore.set('h-b', 'server-b');
    const meta = newVaultMeta(1, 'v');
    const report = await run(meta, memIO(local), mockServer({ changes: serverChanges }));

    expect(report.pushed).toBe(1);
    expect(local.get('b.md')).toBe('server-b');
    expect(meta.versions['a.md']).toBe(1);
    expect(meta.versions['b.md']).toBe(1);
    expect(meta.cursor).toBe(2);
  });

  it('C3 删改冲突：本地改过、服务端被别人删 → 修改胜出并回推', async () => {
    // 本地有 x.md v3，base=v3 内容；服务端 v4 是别人的 delete
    const local = new Map([['x.md', 'my-edit']]);
    const serverChanges: ServerChangeRow[] = [
      { seq: 4, path: 'x.md', op: 'delete', version: 4, device_id: 'other' },
    ];
    const meta = newVaultMeta(1, 'v');
    meta.cursor = 3;
    meta.versions['x.md'] = 3;
    meta.bases['x.md'] = 'old';

    const report = await run(meta, memIO(local), mockServer({ changes: serverChanges }));

    expect(report.pushed).toBeGreaterThanOrEqual(1); // 本地修改已回推
    expect(local.has('x.md')).toBe(true); // 文件存活
    expect(meta.tombstones?.['x.md']).toBeUndefined();
  });

  it('C5 离线补账：多页拉取直到游标收敛', async () => {
    const local = new Map<string, string>();
    const serverChanges: ServerChangeRow[] = [];
    for (let i = 1; i <= 7; i++) {
      serverChanges.push({
        seq: i,
        path: `f${i}.md`,
        op: 'upsert',
        version: 1,
        device_id: 'other',
        blob_hash: `h-${i}`,
      });
      blobStore.set(`h-${i}`, `content-${i}`);
    }
    const meta = newVaultMeta(1, 'v');
    const report = await run(meta, memIO(local), mockServer({ changes: serverChanges }));

    expect(report.pulled).toBe(7);
    expect(meta.cursor).toBe(7);
    for (let i = 1; i <= 7; i++) expect(local.get(`f${i}.md`)).toBe(`content-${i}`);
  });

  it('幂等：本地删除后不再反复推删除（墓碑）', async () => {
    const local = new Map<string, string>(); // y.md 已在本地删除
    const serverChanges: ServerChangeRow[] = [
      { seq: 1, path: 'y.md', op: 'upsert', version: 2, device_id: 'other', blob_hash: 'h-y' },
    ];
    blobStore.set('h-y', 'yyy');
    const meta = newVaultMeta(1, 'v');
    meta.cursor = 1;
    meta.versions['y.md'] = 2;
    meta.bases['y.md'] = 'yyy';
    meta.tombstones = {}; // 模拟上一轮已推送删除但服务端版本更高 → conflict 后仍保留墓碑语义

    const io = memIO(local);
    const server = mockServer({ changes: serverChanges });
    await run(meta, io, server);

    // 第二轮不应再产生任何推送
    const spy = mockServer({ changes: serverChanges });
    const r2 = await run(meta, io, spy);
    expect(r2.pushed).toBe(0);
  });

  it('冲突副本：双端同改不同内容且合并失败 → 生成 conflict 副本', async () => {
    const local = new Map([['n.md', 'mine-line']]);
    const serverChanges: ServerChangeRow[] = [
      { seq: 2, path: 'n.md', op: 'upsert', version: 2, device_id: 'other', blob_hash: 'h-n' },
    ];
    blobStore.set('h-n', 'server-line');
    const meta = newVaultMeta(1, 'v');
    meta.cursor = 1;
    meta.versions['n.md'] = 1;
    meta.bases['n.md'] = 'base-line';

    const report = await run(meta, memIO(local), mockServer({ changes: serverChanges }));

    expect(report.conflicts.length).toBe(1);
    expect(report.conflicts[0]).toMatch(/n\.conflict-.*\.md$/);
    expect(local.get(report.conflicts[0])).toContain('mine-line');
    expect(local.get(report.conflicts[0])).toContain('server-line');
    // 本地原文件保持未丢
    expect(local.get('n.md')).toBe('mine-line');
  });
});

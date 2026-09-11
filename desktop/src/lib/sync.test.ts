import { describe, it, expect } from 'vitest';
import { syncVault, type FileIO, type SyncReport } from './sync';
import { ApiError, SyncClient, type PushChange, type PushResult, type ServerChange } from './api';
import { newVaultMeta, type VaultMeta } from './store';

// ---------- 内存文件系统 ----------

function memIO(files: Map<string, string>): FileIO {
  return {
    async list() {
      return [...files.keys()];
    },
    async listMeta() {
      return [...files.keys()].map((p) => ({ path: p, mtime: 0, size: files.get(p)!.length }));
    },
    async read(_vp, rel) {
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
        /*
         * **假服务端必须和真服务端一样严。**
         * 这里原来不校验 blob 有没有传，照单全收——而真服务端会 rejected。
         * 于是「pushOnly 从不上传 blob」这个 P0 在 17 条一致性用例下全绿，
         * 却在真机上表现为「同步成功、↑0、笔记永远上不去」。假的比真的宽松，
         * 测试就成了自我安慰。
         */
        if (ch.op === 'upsert' && (!ch.blob_hash || !blobStore.has(ch.blob_hash))) {
          results.push({
            client_change_id: ch.client_change_id,
            status: 'rejected',
            reason: 'blob 未上传',
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

describe('推送必须带内容（v0.9.1 P0 回归）', () => {
  it('新文件推上去时 blob 已经先传好，且 change 里带着它的 sha256', async () => {
    const changes: ServerChangeRow[] = [];
    const meta = newVaultMeta(1, 'v');
    const r = await run(meta, memIO(new Map([['a.md', '# 内容\n']])), mockServer({ changes }));
    expect(r.errors).toEqual([]);
    expect(r.pushed).toBe(1);
    // 变更流里必须带 blob_hash——没有它，服务端不知道内容在哪
    expect(changes[0].blob_hash).toBeTruthy();
    // 而且那个 hash 指向的 blob 得真的传上去了
    expect(blobStore.has(changes[0].blob_hash!)).toBe(true);
    expect(blobStore.get(changes[0].blob_hash!)).toBe('# 内容\n');
  });

  it('服务端 rejected 会出现在报告里，不再被静默吞掉', async () => {
    const changes: ServerChangeRow[] = [];
    const server = mockServer({ changes });
    // 让 putBlob 变成空操作：模拟内容没能上传（真服务端会因此 rejected）
    (server as unknown as { putBlob: () => Promise<void> }).putBlob = async () => undefined;
    const meta = newVaultMeta(1, 'v');
    const r = await run(meta, memIO(new Map([['a.md', '# 没传上去的内容\n']])), server);
    expect(r.pushed).toBe(0);
    expect(r.errors.join(' ')).toContain('a.md');
    expect(r.errors.join(' ')).toContain('拒绝');
  });
});

/*
 * 2026-09-08 真机反馈：登录成功，同步永远「推送失败：vault 不存在或不属于你」。
 * 服务端侧核实：那个账号名下一个 vault 都没有——客户端一直拿本地库的负数 id 在推。
 * 光报错没有用，报告必须带上 `unlinked`，上层才知道该去把库重新接到云端。
 */
describe('服务端不认这个库时要能自愈（v0.11.7）', () => {
  it('本地库（负数 id）根本不该往服务端发请求，而是标记成待接入', async () => {
    let called = false;
    const server = mockServer({ changes: [] });
    (server as unknown as { push: () => Promise<never> }).push = async () => {
      called = true;
      throw new Error('不该走到这里');
    };
    const meta = newVaultMeta(-1, '我的笔记');
    const r = await run(meta, memIO(new Map([['a.md', 'x']])), server);

    expect(called).toBe(false);
    expect(r.unlinked).toBe(true);
    expect(r.errors.join(' ')).toContain('我的笔记');
  });

  it('服务端回 403 → unlinked（重试一万次也还是 403，必须先重接）', async () => {
    const server = mockServer({ changes: [] });
    (server as unknown as { push: () => Promise<never> }).push = async () => {
      throw new ApiError(403, 'forbidden', 'vault 不存在或不属于你');
    };
    const meta = newVaultMeta(1, 'v');
    const r = await run(meta, memIO(new Map([['a.md', 'x']])), server);

    expect(r.unlinked).toBe(true);
    expect(r.errors.join(' ')).toContain('推送失败');
  });

  it('普通失败不带 unlinked（别把网络抖动也当成要重建库）', async () => {
    const server = mockServer({ changes: [] });
    (server as unknown as { push: () => Promise<never> }).push = async () => {
      throw new ApiError(500, 'db_error', '数据库炸了');
    };
    const meta = newVaultMeta(1, 'v');
    const r = await run(meta, memIO(new Map([['a.md', 'x']])), server);

    expect(r.unlinked).toBeFalsy();
    expect(r.errors.length).toBe(1);
  });
});

/*
 * 2026-09-08 手机端：一条永远不会消失的红条「拉取失败：refresh token 无效或已过期」。
 * 服务端把 refresh token 轮换掉之后，重试多少次都是同一个 401——报告必须把这件事
 * 单独标出来，上层才能停掉自动重试并把「重新登录」摆到明面上。
 */
describe('登录态过期要能被认出来（v0.11.8）', () => {
  it('refresh 也失败（401 refresh_invalid）→ authExpired', async () => {
    const server = mockServer({ changes: [] });
    (server as unknown as { push: () => Promise<never> }).push = async () => {
      throw new ApiError(401, 'refresh_invalid', 'refresh token 无效或已过期');
    };
    const r = await run(newVaultMeta(1, 'v'), memIO(new Map([['a.md', 'x']])), server);
    expect(r.authExpired).toBe(true);
    expect(r.unlinked).toBeFalsy(); // 别和「库没接上」混成一件事
  });

  it('拉取阶段的 401 同样算数', async () => {
    const server = mockServer({ changes: [] });
    (server as unknown as { pullPage: () => Promise<never> }).pullPage = async () => {
      throw new ApiError(401, 'refresh_invalid', 'refresh token 无效或已过期');
    };
    const r = await run(newVaultMeta(1, 'v'), memIO(new Map()), server);
    expect(r.authExpired).toBe(true);
  });

  /*
   * 2026-09-09：手机上偶尔弹一段「拉取失败：连不上服务器（Failed to fetch）」。
   * 这一类和上面两种正相反——它多半过一会儿自己就好了，所以要能被单独认出来，
   * 上层才敢在**自动**同步时把它压成一句「离线」（见 hooks/useSyncEngine）。
   */
  it('fetch 压根没发出去（network_error）→ offline，且不与另外两个标记混淆', async () => {
    const server = mockServer({ changes: [] });
    (server as unknown as { pullPage: () => Promise<never> }).pullPage = async () => {
      throw new ApiError(0, 'network_error', '连不上服务器（Failed to fetch）。排查提示…');
    };
    const r = await run(newVaultMeta(1, 'v'), memIO(new Map()), server);
    expect(r.offline).toBe(true);
    expect(r.authExpired).toBeFalsy();
    expect(r.unlinked).toBeFalsy();
    expect(r.errors.length).toBe(1); // 报告里照旧留着原因，压不压是上层的事
  });

  it('推送阶段的网络错误同样算数', async () => {
    const server = mockServer({ changes: [] });
    (server as unknown as { push: () => Promise<never> }).push = async () => {
      throw new ApiError(0, 'network_error', '连不上服务器（Failed to fetch）。排查提示…');
    };
    const r = await run(newVaultMeta(1, 'v'), memIO(new Map([['a.md', 'x']])), server);
    expect(r.offline).toBe(true);
  });

  it('服务端明确拒绝（403）不算离线——重试一万次也是同一条', async () => {
    const server = mockServer({ changes: [] });
    (server as unknown as { push: () => Promise<never> }).push = async () => {
      throw new ApiError(403, 'forbidden', 'vault 不存在或不属于你');
    };
    const r = await run(newVaultMeta(1, 'v'), memIO(new Map([['a.md', 'x']])), server);
    expect(r.offline).toBeFalsy();
  });

  it('403 只是库没接上，不是登录过期', async () => {
    const server = mockServer({ changes: [] });
    (server as unknown as { push: () => Promise<never> }).push = async () => {
      throw new ApiError(403, 'forbidden', 'vault 不存在或不属于你');
    };
    const r = await run(newVaultMeta(1, 'v'), memIO(new Map([['a.md', 'x']])), server);
    expect(r.unlinked).toBe(true);
    expect(r.authExpired).toBeFalsy();
  });
});

// ---------- 附件同步（v0.11.10）----------
//
// 单独一套字节级的假服务端与假文件系统：上面那套 blobStore 存的是 string，
// 它验不出"PDF 被当成文本走了一遍 UTF-8 编解码"这类损坏——而这正是附件同步
// 唯一真正要保证的事。

function memBytesIO(files: Map<string, Uint8Array>): FileIO {
  return {
    async list() {
      return [...files.keys()];
    },
    async listMeta() {
      return [...files.keys()].map((p) => ({ path: p, mtime: 0, size: files.get(p)!.length }));
    },
    async read(_vp, rel) {
      const v = files.get(rel);
      if (v === undefined) throw new Error(`not found: ${rel}`);
      return new TextDecoder().decode(v);
    },
    async write(_vp, rel, content) {
      files.set(rel, new TextEncoder().encode(content));
    },
    async readBinary(_vp, rel) {
      const v = files.get(rel);
      if (v === undefined) throw new Error(`not found: ${rel}`);
      return v;
    },
    async writeBinary(_vp, rel, data) {
      files.set(rel, data);
    },
    async remove(_vp, rel) {
      files.delete(rel);
    },
    async exists(_vp, rel) {
      return files.has(rel);
    },
  };
}

function mockBytesServer(changes: ServerChangeRow[], blobs: Map<string, Uint8Array>) {
  let seq = changes.reduce((m, c) => Math.max(m, c.seq), 0);
  const versions = new Map<string, number>();
  for (const c of changes) versions.set(c.path, c.version);
  return {
    push: async (_vaultId: number, batch: PushChange[]) => {
      const results: PushResult[] = [];
      for (const ch of batch) {
        const cur = versions.get(ch.path) ?? 0;
        if (ch.base_version < cur) {
          results.push({ client_change_id: ch.client_change_id, status: 'conflict', server_version: cur });
          continue;
        }
        if (ch.op === 'upsert' && (!ch.blob_hash || !blobs.has(ch.blob_hash))) {
          results.push({ client_change_id: ch.client_change_id, status: 'rejected', reason: 'blob 未上传' });
          continue;
        }
        const next = cur + 1;
        versions.set(ch.path, next);
        changes.push({
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
      const page = changes.filter((c) => c.seq > cursor).slice(0, 500);
      const next = page.length ? page[page.length - 1].seq : cursor;
      return { changes: page.map(({ ...c }) => c), next_cursor: next };
    },
    getBlob: async (hash: string) => {
      const b = blobs.get(hash)!;
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    },
    putBlob: async (bytes: Uint8Array) => {
      blobs.set(await sha256(bytes), bytes.slice());
    },
  } as unknown as SyncClient;
}

/** 一段绝不是合法 UTF-8 的字节（PDF 头 + 0x00 + 孤立的 0xFF）*/
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x00, 0xff, 0xfe, 0x01]);

describe('附件同步（PDF / 图片 / .base）', () => {
  it('A1 本地 PDF 会被推上去，并记下它的哈希', async () => {
    const local = new Map<string, Uint8Array>([['Attachments/a.pdf', PDF_BYTES]]);
    const blobs = new Map<string, Uint8Array>();
    const meta = newVaultMeta(1, 'v');
    const report = await run(meta, memBytesIO(local), mockBytesServer([], blobs));

    expect(report.errors).toEqual([]);
    expect(report.pushed).toBe(1);
    expect(meta.assets?.['Attachments/a.pdf']).toBe(await sha256(PDF_BYTES));
    expect([...blobs.values()][0]).toEqual(PDF_BYTES);
  });

  it('A2 远端 PDF 拉下来必须逐字节一致（不许走一遍文本编解码）', async () => {
    const local = new Map<string, Uint8Array>();
    const blobs = new Map<string, Uint8Array>();
    const hash = await sha256(PDF_BYTES);
    blobs.set(hash, PDF_BYTES);
    const changes: ServerChangeRow[] = [
      { seq: 1, path: 'a.pdf', op: 'upsert', version: 1, device_id: 'other', blob_hash: hash },
    ];
    const meta = newVaultMeta(1, 'v');
    const report = await run(meta, memBytesIO(local), mockBytesServer(changes, blobs));

    expect(report.pulled).toBe(1);
    expect(local.get('a.pdf')).toEqual(PDF_BYTES);
    expect(meta.assets?.['a.pdf']).toBe(hash);
  });

  it('A3 没动过的附件不会被反复上传', async () => {
    const local = new Map<string, Uint8Array>([['a.pdf', PDF_BYTES]]);
    const blobs = new Map<string, Uint8Array>();
    const changes: ServerChangeRow[] = [];
    const meta = newVaultMeta(1, 'v');
    await run(meta, memBytesIO(local), mockBytesServer(changes, blobs));
    const second = await run(meta, memBytesIO(local), mockBytesServer(changes, blobs));

    expect(second.pushed).toBe(0);
    expect(second.errors).toEqual([]);
  });

  it('A4 附件不会被当成"本地已删"而推出删除（localAll 回归）', async () => {
    const local = new Map<string, Uint8Array>([
      ['n.md', new TextEncoder().encode('hi')],
      ['a.pdf', PDF_BYTES],
    ]);
    const blobs = new Map<string, Uint8Array>();
    const changes: ServerChangeRow[] = [];
    const meta = newVaultMeta(1, 'v');
    await run(meta, memBytesIO(local), mockBytesServer(changes, blobs));
    await run(meta, memBytesIO(local), mockBytesServer(changes, blobs));

    expect(changes.some((c) => c.op === 'delete')).toBe(false);
    expect(local.has('a.pdf')).toBe(true);
  });

  it('A5 两端都改：服务端版本落原路径，本地那份留成同扩展名的冲突副本', async () => {
    const mine = new Uint8Array([1, 2, 3, 4]);
    const theirs = new Uint8Array([9, 9, 9]);
    const local = new Map<string, Uint8Array>([['a.pdf', mine]]);
    const blobs = new Map<string, Uint8Array>();
    const theirHash = await sha256(theirs);
    blobs.set(theirHash, theirs);
    const changes: ServerChangeRow[] = [
      { seq: 5, path: 'a.pdf', op: 'upsert', version: 5, device_id: 'other', blob_hash: theirHash },
    ];
    const meta = newVaultMeta(1, 'v');
    meta.cursor = 4;
    meta.versions['a.pdf'] = 4;
    meta.assets = { 'a.pdf': await sha256(new Uint8Array([7, 7])) }; // 上次同步时是别的内容 = 本地改过

    const report = await run(meta, memBytesIO(local), mockBytesServer(changes, blobs));

    expect(local.get('a.pdf')).toEqual(theirs);
    const copy = report.conflicts[0];
    expect(copy).toMatch(/^a\.conflict-.*\.pdf$/);
    expect(local.get(copy)).toEqual(mine);
  });

  it('A6 超过 50MB 的附件说清楚原因，而不是静默不同步', async () => {
    const big = new Uint8Array((50 << 20) + 1);
    const local = new Map<string, Uint8Array>([['big.zip', big]]);
    const meta = newVaultMeta(1, 'v');
    const report = await run(meta, memBytesIO(local), mockBytesServer([], new Map()));

    expect(report.pushed).toBe(0);
    expect(report.errors.join()).toMatch(/50MB/);
  });
});

describe('本机私有目录不进同步（v0.11.11 修的回归）', () => {
  it('A7 .ivyea/ 与 .trash/ 一个字节都不上传', async () => {
    const local = new Map<string, Uint8Array>([
      ['n.md', new TextEncoder().encode('正文')],
      ['.ivyea/cache/content.json', new TextEncoder().encode('{"index":1}')],
      ['.trash/删了的.md', new TextEncoder().encode('旧内容')],
    ]);
    const blobs = new Map<string, Uint8Array>();
    const changes: ServerChangeRow[] = [];
    const meta = newVaultMeta(1, 'v');
    const report = await run(meta, memBytesIO(local), mockBytesServer(changes, blobs));

    expect(report.errors).toEqual([]);
    expect(changes.map((c) => c.path)).toEqual(['n.md']);
    expect(meta.versions['.ivyea/cache/content.json']).toBeUndefined();
  });

  it('A8 云端已有的 .ivyea/ 不会落回本地（旧版本推上去的那些）', async () => {
    const local = new Map<string, Uint8Array>();
    const blobs = new Map<string, Uint8Array>();
    const h = await sha256(new TextEncoder().encode('别人的索引缓存'));
    blobs.set(h, new TextEncoder().encode('别人的索引缓存'));
    const changes: ServerChangeRow[] = [
      { seq: 1, path: '.ivyea/cache/content.json', op: 'upsert', version: 1, device_id: 'other', blob_hash: h },
    ];
    const meta = newVaultMeta(1, 'v');
    await run(meta, memBytesIO(local), mockBytesServer(changes, blobs));

    expect(local.has('.ivyea/cache/content.json')).toBe(false);
  });

  it('A9 一个附件失败不该让整轮同步停摆（拉取照跑）', async () => {
    // 本地有一个超大的附件（推不上去），服务端有一篇别人写的笔记（必须拉下来）
    const local = new Map<string, Uint8Array>([['big.zip', new Uint8Array((50 << 20) + 1)]]);
    const blobs = new Map<string, Uint8Array>();
    const h = await sha256(new TextEncoder().encode('远端的正文'));
    blobs.set(h, new TextEncoder().encode('远端的正文'));
    const changes: ServerChangeRow[] = [
      { seq: 1, path: '远端.md', op: 'upsert', version: 1, device_id: 'other', blob_hash: h },
    ];
    const meta = newVaultMeta(1, 'v');
    const report = await run(meta, memBytesIO(local), mockBytesServer(changes, blobs));

    expect(report.errors.join()).toMatch(/50MB/); // 那一个仍然要说清楚
    expect(new TextDecoder().decode(local.get('远端.md')!)).toBe('远端的正文'); // 其余照常
    expect(report.pulled).toBe(1);
  });
});

describe('文件历史（v0.11.24）：远端删除进回收站、自动合并前留快照', () => {
  it('H1 别的设备删了一篇 → 这台机器不再直接物理删，先进自己的 .trash/', async () => {
    const local = new Map([['日记/x.md', 'x-content']]);
    const serverChanges: ServerChangeRow[] = [
      { seq: 4, path: '日记/x.md', op: 'delete', version: 4, device_id: 'other' },
    ];
    const meta = newVaultMeta(1, 'v');
    meta.cursor = 3;
    meta.versions['日记/x.md'] = 3;
    meta.bases['日记/x.md'] = 'x-content';

    await run(meta, memIO(local), mockServer({ changes: serverChanges }));

    expect(local.has('日记/x.md')).toBe(false); // 跟随删除
    const trashed = [...local.keys()].filter((p) => p.startsWith('.trash/'));
    expect(trashed).toHaveLength(1);
    expect(trashed[0]).toMatch(/^\.trash\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-日记__x\.md$/);
    expect(local.get(trashed[0])).toBe('x-content');
    // 回收站里的东西不会被当作"本地新文件"推上去
    expect(meta.versions['.trash/' + trashed[0].slice('.trash/'.length)]).toBeUndefined();
  });

  it('H2 远端删的附件同样进回收站', async () => {
    const local = new Map([['图/a.png', 'PNGBYTES']]);
    const serverChanges: ServerChangeRow[] = [
      { seq: 2, path: '图/a.png', op: 'delete', version: 2, device_id: 'other' },
    ];
    const meta = newVaultMeta(1, 'v');
    meta.cursor = 1;
    meta.versions['图/a.png'] = 1;
    meta.assets = { '图/a.png': await sha256(new TextEncoder().encode('PNGBYTES')) };

    await run(meta, memIO(local), mockServer({ changes: serverChanges }));

    expect(local.has('图/a.png')).toBe(false);
    const trashed = [...local.keys()].filter((p) => p.startsWith('.trash/'));
    expect(trashed).toHaveLength(1);
    expect(local.get(trashed[0])).toBe('PNGBYTES');
  });

  it('H3 三方自动合并覆盖本地之前，本地那份留在 .ivyea/history/', async () => {
    const local = new Map([['n.md', 'base\nmine']]);
    const serverChanges: ServerChangeRow[] = [
      { seq: 2, path: 'n.md', op: 'upsert', version: 2, device_id: 'other', blob_hash: 'h-m' },
    ];
    blobStore.set('h-m', 'theirs\nbase');
    const meta = newVaultMeta(1, 'v');
    meta.cursor = 1;
    meta.versions['n.md'] = 1;
    meta.bases['n.md'] = 'base';

    const report = await run(meta, memIO(local), mockServer({ changes: serverChanges }));

    expect(report.merged).toBe(1);
    expect(local.get('n.md')).toBe('theirs\nbase\nmine');
    const snaps = [...local.keys()].filter((p) => p.startsWith('.ivyea/history/n.md/'));
    expect(snaps).toHaveLength(1);
    expect(local.get(snaps[0])).toBe('base\nmine');
  });
});

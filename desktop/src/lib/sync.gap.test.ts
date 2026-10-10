/**
 * v0.11.38：拉取中途断网，游标不许越过没应用成功的变更；已经越过去的，全量对账补回来。
 *
 * 真实事故（2026-09-30，nginx 日志 + 服务端 changes 表对出来的）：新手机首次同步，
 * 10:18:24 起锁屏 38 秒，这段时间 blob 请求一个都没发出去（fetch 抛 TypeError），
 * 引擎把约 200 条变更逐条"失败"过去，游标却推到了页尾 5460——「日常代办.md」v1~v5、
 * 「个人空间.base」从此再也拉不到，新手机上一直没有这两个文件。
 */
import { describe, expect, it } from 'vitest';
import { reconcileWanted, syncVault, type FileIO } from './sync';
import { ApiError, SyncClient, type ServerChange } from './api';
import { newVaultMeta, type VaultMeta } from './store';

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

const blobs: Record<string, string> = {
  'h-a': '杂记',
  'h-d1': '',
  'h-d2': '- [ ] 买菜',
  'h-d5': '- [ ] 买菜\n- [x] 交房租',
  'h-base': 'filters: 个人空间',
  'h-z': '灵感',
};

/** 和事故同形状的变更流：杂记 → 个人空间.base → 日常代办 v1/v2/v5 → 灵感随笔 */
function stream(): ServerChange[] {
  return [
    { seq: 10, path: '杂记.md', op: 'upsert', version: 1, device_id: 'desktop', blob_hash: 'h-a' },
    { seq: 11, path: '个人空间.base', op: 'upsert', version: 1, device_id: 'desktop', blob_hash: 'h-base' },
    { seq: 12, path: '日常代办.md', op: 'upsert', version: 1, device_id: 'desktop', blob_hash: 'h-d1' },
    { seq: 13, path: '日常代办.md', op: 'upsert', version: 2, device_id: 'desktop', blob_hash: 'h-d2' },
    { seq: 14, path: '日常代办.md', op: 'upsert', version: 5, device_id: 'desktop', blob_hash: 'h-d5' },
    { seq: 15, path: '灵感随笔.md', op: 'upsert', version: 1, device_id: 'desktop', blob_hash: 'h-z' },
  ];
}

/**
 * `offline(hash)` 为真时 getBlob 像锁屏那样失败。`netError` 选失败的形状：
 * 'typeerror' = v0.11.37 及以前 getBlob 真实抛出来的原生 TypeError（没包成 ApiError），
 * 'api' = 本版 rawNet 包出来的 network_error。
 */
function server(changes: ServerChange[], offline: (hash: string) => boolean, netError: 'typeerror' | 'api' = 'api') {
  const calls = { pulls: [] as number[], blobs: [] as string[] };
  const client = {
    pullPage: async (_v: number, cursor: number) => {
      calls.pulls.push(cursor);
      const page = changes.filter((c) => c.seq > cursor).slice(0, 2); // 小页，跨页也要对
      return { changes: page.map((c) => ({ ...c })), next_cursor: page.length ? page[page.length - 1].seq : cursor };
    },
    getBlob: async (hash: string) => {
      if (offline(hash)) {
        if (netError === 'typeerror') throw new TypeError('Failed to fetch');
        throw new ApiError(0, 'network_error', '连不上服务器（Failed to fetch）');
      }
      calls.blobs.push(hash);
      return new TextEncoder().encode(blobs[hash]).buffer as ArrayBuffer;
    },
    push: async () => ({ results: [] }),
    putBlob: async () => undefined,
  } as unknown as SyncClient;
  return { client, calls };
}

function meta(): VaultMeta {
  return { ...newVaultMeta(11, 'obsidian'), localPath: '/vault' };
}

describe('拉取中途断网（2026-09-30 新手机锁屏 38 秒）', () => {
  it('断网那条之后游标停住；恢复网络后下一轮把漏掉的全部补上', async () => {
    const files = new Map<string, string>();
    const m = meta();
    let locked = true;
    // 杂记 下载成功之后锁屏：后面的 blob 全都发不出去
    const { client } = server(stream(), (h) => locked && h !== 'h-a');

    const r1 = await syncVault(client, m, memIO(files), 'phone', '/vault');
    expect(r1.offline).toBe(true);
    expect(files.get('杂记.md')).toBe('杂记');
    // 关键断言：游标停在最后一条成功的位置，没有越过「个人空间.base」
    expect(m.cursor).toBe(10);

    locked = false;
    await syncVault(client, m, memIO(files), 'phone', '/vault');
    expect(files.get('日常代办.md')).toBe('- [ ] 买菜\n- [x] 交房租');
    expect(files.get('个人空间.base')).toBe('filters: 个人空间');
    expect(files.get('灵感随笔.md')).toBe('灵感');
    expect(m.cursor).toBe(15);
  });

  it('非 ApiError 的失败（如 v0.11.37 getBlob 抛的原生 TypeError）也不能被吞：记 reconcileDue 等对账补', async () => {
    const files = new Map<string, string>();
    const m = meta();
    m.reconciledAt = Date.now(); // 只看游标这一层，不让对账兜底掩盖问题
    const { client } = server(stream(), (h) => h !== 'h-a', 'typeerror');
    await syncVault(client, m, memIO(files), 'phone', '/vault');
    // TypeError 不是 ApiError：不算链路故障，但也绝不能"失败了还当没事"——
    // 这一层继续往下走，记下 reconcileDue，对账会再补
    expect(m.reconcileDue).toBe(true);
  });

  it('单个文件写不进去不挡其它文件，记 reconcileDue，下次对账补上', async () => {
    const files = new Map<string, string>();
    const io = memIO(files);
    let broken = true;
    const write = io.write;
    io.write = async (vp, rel, c) => {
      if (broken && rel === '日常代办.md') throw new Error('SAF 写入失败');
      return write(vp, rel, c);
    };
    const m = meta();
    m.reconciledAt = Date.now();
    const { client } = server(stream(), () => false);

    const r1 = await syncVault(client, m, io, 'phone', '/vault');
    expect(r1.errors.some((e) => e.includes('日常代办.md'))).toBe(true);
    expect(files.get('灵感随笔.md')).toBe('灵感'); // 后面的照常
    expect(m.cursor).toBe(15);
    expect(m.reconcileDue).toBe(true);

    broken = false;
    m.reconciledAt = Date.now() - 6 * 60 * 1000; // 过了重试间隔
    await syncVault(client, m, io, 'phone', '/vault');
    expect(files.get('日常代办.md')).toBe('- [ ] 买菜\n- [x] 交房租');
    expect(m.reconcileDue).toBe(false);
  });
});

describe('已经被旧版本走坏的账本：升级后第一次同步自愈', () => {
  /** 新手机的真实状态：游标已过 15，账本里没有「日常代办」「个人空间.base」 */
  function brokenPhone(): { m: VaultMeta; files: Map<string, string> } {
    const m = meta();
    m.cursor = 15;
    m.versions = { '杂记.md': 1, '灵感随笔.md': 1 };
    m.bases = { '杂记.md': '杂记', '灵感随笔.md': '灵感' };
    m.syncedAt = '/vault';
    return { m, files: new Map([['杂记.md', '杂记'], ['灵感随笔.md', '灵感']]) };
  }

  it('没有 reconciledAt → 全量对账，把漏掉的两个文件拉下来', async () => {
    const { m, files } = brokenPhone();
    const { client, calls } = server(stream(), () => false);
    const r = await syncVault(client, m, memIO(files), 'phone', '/vault');
    expect(r.errors).toEqual([]);
    expect(files.get('日常代办.md')).toBe('- [ ] 买菜\n- [x] 交房租');
    expect(files.get('个人空间.base')).toBe('filters: 个人空间');
    expect(m.versions['日常代办.md']).toBe(5);
    // 只下最新那版，不把 v1/v2 也拖下来；已有的两个文件不重复下载
    expect(calls.blobs.sort()).toEqual(['h-base', 'h-d5']);
    expect(m.reconciledAt).toBeTypeOf('number');
    expect(m.cursor).toBe(15);
  });

  it('阴性对照：账本标记过刚对过账 → 不对账，漏掉的仍然缺（证明是对账补上的）', async () => {
    const { m, files } = brokenPhone();
    m.reconciledAt = Date.now();
    const { client } = server(stream(), () => false);
    await syncVault(client, m, memIO(files), 'phone', '/vault');
    expect(files.has('日常代办.md')).toBe(false);
  });

  it('对账不覆盖本地改动：账本落后但本地改过 → 3-way 合并或冲突副本，本地那份一定在', async () => {
    const { m, files } = brokenPhone();
    m.versions['日常代办.md'] = 2;
    m.bases['日常代办.md'] = '- [ ] 买菜';
    files.set('日常代办.md', '- [ ] 买菜\n- [ ] 手机上加的');
    const { client } = server(stream(), () => false);
    await syncVault(client, m, memIO(files), 'phone', '/vault');
    expect(files.get('日常代办.md')).toContain('手机上加的');
    // 两端在同一处追加 → 合不了，云端那份进冲突副本（人来裁决），账本追平到 v5
    const all = [...files.entries()].filter(([p]) => p.startsWith('日常代办')).map(([, v]) => v).join('\n');
    expect(all).toContain('交房租');
    expect(m.versions['日常代办.md']).toBe(5);
  });

  it('对账节奏：老账本马上、出错后隔 5 分钟、平时一周一次', () => {
    const now = 1_000_000_000_000;
    const m = meta();
    expect(reconcileWanted(m, now)).toBe(true);
    m.reconciledAt = now - 60_000;
    expect(reconcileWanted(m, now)).toBe(false);
    m.reconcileDue = true;
    expect(reconcileWanted(m, now)).toBe(false);
    m.reconciledAt = now - 5 * 60_000;
    expect(reconcileWanted(m, now)).toBe(true);
    m.reconcileDue = false;
    expect(reconcileWanted(m, now)).toBe(false);
    m.reconciledAt = now - 7 * 24 * 3600_000;
    expect(reconcileWanted(m, now)).toBe(true);
  });
});

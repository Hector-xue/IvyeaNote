import { describe, expect, it, vi } from 'vitest';

/*
 * fs-adapters 走的是 OPFS / Tauri，node 里没有；这里换成一份按 vault id 分桶的
 * 内存实现，好让「OPFS 库换 id 要搬家、绑盘库不许搬家」这条能被真的断言到。
 */
const stores = new Map<number, Map<string, string>>();
function bucket(id: number): Map<string, string> {
  if (!stores.has(id)) stores.set(id, new Map());
  return stores.get(id)!;
}
vi.mock('./fs-adapters', async () => {
  const { migrateFiles } = await vi.importActual<typeof import('./fs-adapters')>('./fs-adapters');
  return {
    migrateFiles: vi.fn(migrateFiles),
    opfsIO: (getMeta: () => { id: number }) => ({
      async list() {
        return [...bucket(getMeta().id).keys()];
      },
      async read(_vp: string, rel: string) {
        return bucket(getMeta().id).get(rel)!;
      },
      async write(_vp: string, rel: string, c: string) {
        bucket(getMeta().id).set(rel, c);
      },
      async remove(_vp: string, rel: string) {
        bucket(getMeta().id).delete(rel);
      },
      async exists(_vp: string, rel: string) {
        return bucket(getMeta().id).has(rel);
      },
      async readBinary(_vp: string, rel: string) {
        return new TextEncoder().encode(bucket(getMeta().id).get(rel)!);
      },
      async writeBinary(_vp: string, rel: string, b: Uint8Array) {
        bucket(getMeta().id).set(rel, new TextDecoder().decode(b));
      },
    }),
  };
});

import { linkVaults } from './vaultLink';
import { migrateFiles } from './fs-adapters';
import { newVaultMeta, type PersistState, type VaultMeta } from './store';
import type { SyncClient } from './api';

function fakeClient(remote: { id: number; name: string }[], deleted: number[] = []) {
  let next = Math.max(0, ...remote.map((v) => v.id), ...deleted) + 1;
  const created: string[] = [];
  const client = {
    async listVaults() {
      return { vaults: remote.map((v) => ({ ...v, created_at: '' })), deleted };
    },
    async createVault(name: string) {
      created.push(name);
      return { id: next++, name };
    },
  } as unknown as SyncClient;
  return { client, created };
}

function local(id: number, name: string, localPath?: string): VaultMeta {
  return { ...newVaultMeta(id, name), ...(localPath ? { localPath } : {}) };
}

function state(...vaults: VaultMeta[]): PersistState {
  return { vaults: Object.fromEntries(vaults.map((v) => [String(v.id), v])) };
}

describe('linkVaults', () => {
  /*
   * 用户 2026-09-08 报的那条：登录着、却一直「推送失败：vault 不存在或不属于你」。
   * 服务端侧核实过该账号名下 0 个 vault —— 客户端拿着本地库的负数 id 在推。
   */
  it('云端一个库都没有：把本地库升级成云端库，并把绑定的磁盘文件夹原样带过去', async () => {
    const { client, created } = fakeClient([]);
    const cur = state(local(-1, '我的笔记', 'E:\\obsidian\\obsidian'));

    const r = await linkVaults(client, cur, -1);

    expect(created).toEqual(['我的笔记']);
    expect(r.activeId).toBeGreaterThan(0);
    const next = r.vaults[String(r.activeId)]!;
    // 绑定必须继承：此前这里建的是 newVaultMeta（localPath=opfs://<id>），
    // 用户选的磁盘文件夹被静默换成应用内部存储，笔记「看起来全没了」
    expect(next.localPath).toBe('E:\\obsidian\\obsidian');
    expect(r.vaults['-1']).toBeUndefined();
    // 绑了真实文件夹就不该搬文件
    expect(migrateFiles).not.toHaveBeenCalled();
  });

  it('OPFS 本地库换 id 时把笔记搬过去（存储目录是 vault-<id>，不搬就眼前一空）', async () => {
    const { client } = fakeClient([]);
    bucket(-1).set('a.md', '正文');
    const r = await linkVaults(client, state(local(-1, '我的笔记')), -1);

    expect(r.linked?.copied).toBe(1);
    expect(bucket(r.activeId!).get('a.md')).toBe('正文');
  });

  it('云端已有库：并入最旧的那个，不再建重名空库', async () => {
    const { client, created } = fakeClient([
      { id: 7, name: '工作' },
      { id: 3, name: '生活' },
    ]);
    const r = await linkVaults(client, state(local(-1, '我的笔记', '/data/notes')), -1);

    expect(created).toEqual([]);
    expect(r.activeId).toBe(3);
    expect(r.vaults['3']!.localPath).toBe('/data/notes');
    expect(r.vaults['7']).toBeDefined(); // 另一个云端库要补进来
  });

  it('其余本地库一个都不丢（登录曾把 -2、-3 从 state 里抹掉）', async () => {
    const { client } = fakeClient([]);
    const cur = state(local(-1, '我的笔记', '/a'), local(-2, '第二个库', '/b'));
    const r = await linkVaults(client, cur, -1);

    expect(r.vaults['-2']).toBeDefined();
    expect(r.vaults['-2']!.localPath).toBe('/b');
  });

  it('孤儿云端库（服务端已经没有它了）：重开一个云端库，且不把旧进度带过去', async () => {
    const { client, created } = fakeClient([]);
    const orphan: VaultMeta = {
      ...local(5, '旧云端库', '/data/notes'),
      cursor: 42,
      versions: { 'a.md': 9 },
      bases: { 'a.md': '旧内容' },
    };
    const r = await linkVaults(client, state(orphan), 5);

    expect(created).toEqual(['旧云端库']);
    const next = r.vaults[String(r.activeId)]!;
    expect(next.localPath).toBe('/data/notes');
    // 版本号只在同一个服务端库里有意义；带过去会让 pushOnly 判成「没变化」，
    // 笔记一篇都传不上去，界面还显示同步成功
    expect(next.cursor).toBe(0);
    expect(next.versions).toEqual({});
    expect(next.bases).toEqual({});
    expect(r.vaults['5']).toBeUndefined();
  });

  it('当前库服务端认得：什么都不做（别每次同步都建一个新库）', async () => {
    const { client, created } = fakeClient([{ id: 3, name: '生活' }]);
    const r = await linkVaults(client, state(local(3, '生活', '/data/notes')), 3);

    expect(created).toEqual([]);
    expect(r.linked).toBeNull();
    expect(r.activeId).toBe(3);
  });
});

/*
 * v0.11.25：别的设备删掉的云端库，这台设备要**放手**，不能再当孤儿收养——
 * 否则手机上删掉的测试库会在电脑上以另一个 id 复活，删了等于没删。
 */
describe('linkVaults · 服务端已删除的库', () => {
  it('绑了磁盘文件夹的：从列表去掉，文件原地不动，不新建云端库', async () => {
    const { client, created } = fakeClient([{ id: 1, name: '主库' }], [7]);
    const cur = state(
      { ...local(1, '主库'), localPath: 'D:\\notes' },
      { ...local(7, '测试库'), localPath: 'D:\\test' }
    );

    const r = await linkVaults(client, cur, 1);

    expect(created).toEqual([]);
    expect(Object.keys(r.vaults)).toEqual(['1']);
    expect(r.released).toEqual([{ id: 7, name: '测试库', keptAs: null }]);
    expect(r.activeId).toBe(1);
  });

  it('存在应用内部且有内容的：转成本地库留着，一篇不丢', async () => {
    const { client, created } = fakeClient([{ id: 1, name: '主库' }], [8]);
    bucket(8).set('草稿.md', '内容');
    const cur = state({ ...local(1, '主库'), localPath: 'D:\\notes' }, local(8, '旧库'));

    const r = await linkVaults(client, cur, 1);

    expect(created).toEqual([]);
    expect(r.vaults['8']).toBeUndefined();
    const kept = r.released[0]!.keptAs!;
    expect(kept).toBeLessThan(0);
    expect(r.vaults[String(kept)]!.name).toBe('旧库');
    expect(bucket(kept).get('草稿.md')).toBe('内容');
  });

  it('存在应用内部但空的：直接去掉（正是那些"测试用的空白库"）', async () => {
    const { client } = fakeClient([{ id: 1, name: '主库' }], [9]);
    const cur = state({ ...local(1, '主库'), localPath: 'D:\\notes' }, local(9, '空库'));

    const r = await linkVaults(client, cur, 1);

    expect(Object.keys(r.vaults)).toEqual(['1']);
    expect(r.released).toEqual([{ id: 9, name: '空库', keptAs: null }]);
  });

  it('老服务端不给 deleted 字段：行为和以前一样（孤儿照旧收养）', async () => {
    const client = {
      async listVaults() {
        return { vaults: [{ id: 1, name: '主库', created_at: '' }] };
      },
      async createVault(name: string) {
        return { id: 99, name };
      },
    } as unknown as SyncClient;
    const cur = state({ ...local(1, '主库'), localPath: 'D:\\notes' }, { ...local(5, '孤儿'), localPath: 'D:\\x' });

    const r = await linkVaults(client, cur, 5);

    expect(r.released).toEqual([]);
    expect(r.linked?.from).toBe(5);
  });
});

describe('linkVaults 不克隆已有的库（v0.11.28）', () => {
  /*
   * 启动对齐每次都跑，而同一时刻自动同步正拿着旧对象写账本。克隆 = 那一轮的墓碑 /
   * 附件哈希 / 游标只落在旧对象上、被 persist 丢掉（2026-09-12「本地少了 184 篇」）。
   */
  it('服务端认得的库保持同一个对象，名字就地改', async () => {
    const { client } = fakeClient([{ id: 11, name: 'obsidian-renamed' }]);
    const had: VaultMeta = { ...newVaultMeta(11, 'obsidian'), localPath: 'content://tree/x' };
    const r = await linkVaults(client, state(had), 11);
    expect(r.vaults['11']).toBe(had);
    expect(had.name).toBe('obsidian-renamed');
    expect(had.localPath).toBe('content://tree/x');
  });
});

/**
 * 每文件同步状态。
 *
 * 这个面板存在的意义是「让静默失败不再静默」，所以最要紧的一条是：
 * **只要本地内容和最后一次同步成功的内容不一样，就必须显示成待推送**——
 * 不管同步报告说了什么。v0.9.1 之前推送根本不传 blob、服务端全拒、报告却是
 * 「↑0」一片祥和，正是因为没有任何地方按「内容对不对得上」去判。
 */
import { describe, expect, it } from 'vitest';
import {
  classifyVault,
  isConflictCopy,
  originalOfConflict,
  summarize,
  STATE_LABEL,
  type FileSyncStatus,
} from './syncStatus';

const meta = (over: Partial<{ versions: Record<string, number>; bases: Record<string, string>; tombstones: Record<string, number> }> = {}) => ({
  versions: over.versions ?? {},
  bases: over.bases ?? {},
  tombstones: over.tombstones,
});

const byPath = (list: FileSyncStatus[]) =>
  Object.fromEntries(list.map((f) => [f.path, f.state]));

describe('单文件判定', () => {
  it('服务端没有这条路径 → 新增待推送', () => {
    const r = classifyVault(new Map([['a.md', '内容']]), meta());
    expect(byPath(r)).toEqual({ 'a.md': 'new' });
  });

  it('内容与 base 一致 → 已同步', () => {
    const r = classifyVault(
      new Map([['a.md', '内容']]),
      meta({ versions: { 'a.md': 3 }, bases: { 'a.md': '内容' } })
    );
    expect(byPath(r)).toEqual({ 'a.md': 'synced' });
    expect(r[0].version).toBe(3);
  });

  it('内容与 base 不一致 → 待推送（已修改）', () => {
    const r = classifyVault(
      new Map([['a.md', '改过了']]),
      meta({ versions: { 'a.md': 3 }, bases: { 'a.md': '原内容' } })
    );
    expect(byPath(r)).toEqual({ 'a.md': 'modified' });
  });

  it('有版本号但 base 缺失时按待推送算，不能误判成已同步', () => {
    // base 缺失说明我们不知道服务端那份长什么样，只能保守当作有待推送
    const r = classifyVault(new Map([['a.md', '有内容']]), meta({ versions: { 'a.md': 1 } }));
    expect(byPath(r)).toEqual({ 'a.md': 'modified' });
  });

  it('空文件且 base 也是空 → 已同步', () => {
    const r = classifyVault(
      new Map([['a.md', '']]),
      meta({ versions: { 'a.md': 1 }, bases: { 'a.md': '' } })
    );
    expect(byPath(r)).toEqual({ 'a.md': 'synced' });
  });
});

describe('删除', () => {
  it('本地没了、服务端还有 → 待推送（已删除）', () => {
    const r = classifyVault(new Map(), meta({ versions: { 'a.md': 3 } }));
    expect(byPath(r)).toEqual({ 'a.md': 'deleted' });
  });

  it('墓碑已记录的删除不再算待办，否则面板永远清不空', () => {
    const r = classifyVault(new Map(), meta({ versions: { 'a.md': 3 }, tombstones: { 'a.md': 3 } }));
    expect(r).toEqual([]);
  });

  it('墓碑版本对不上（删完又被别人改过）仍然算待推送', () => {
    const r = classifyVault(new Map(), meta({ versions: { 'a.md': 5 }, tombstones: { 'a.md': 3 } }));
    expect(byPath(r)).toEqual({ 'a.md': 'deleted' });
  });
});

describe('冲突副本', () => {
  it('认得出冲突副本', () => {
    expect(isConflictCopy('笔记.conflict-2026-08-29T10-30-00.md')).toBe(true);
    expect(isConflictCopy('笔记.md')).toBe(false);
    expect(isConflictCopy('conflict.md')).toBe(false);
  });

  it('冲突副本单独归类，不跟普通待推送混在一起', () => {
    const r = classifyVault(
      new Map([
        ['a.md', 'x'],
        ['a.conflict-2026-08-29T10-30-00.md', 'y'],
      ]),
      meta({ versions: { 'a.md': 1 }, bases: { 'a.md': 'x' } })
    );
    expect(byPath(r)['a.conflict-2026-08-29T10-30-00.md']).toBe('conflict');
    expect(byPath(r)['a.md']).toBe('synced');
  });

  it('从副本名反解原路径——.md 必须留着', () => {
    // 旧实现把 .md 一起吃掉了，「采用副本」会写进一个没有扩展名的新文件，
    // 原笔记原封不动：用户以为解决了，其实内容还是旧的
    expect(originalOfConflict('日记/a.conflict-2026-08-29T10-30-00.md')).toBe('日记/a.md');
    expect(originalOfConflict('a.conflict-2026-08-29T10-30-00.md')).toBe('a.md');
  });

  it('不是副本的路径原样返回', () => {
    expect(originalOfConflict('日记/a.md')).toBe('日记/a.md');
  });
});

describe('汇总与排序', () => {
  it('待推送把新增/修改/删除都算进去', () => {
    const list = classifyVault(
      new Map([
        ['新.md', 'x'],
        ['改.md', '新内容'],
        ['稳.md', '一样'],
      ]),
      meta({
        versions: { '改.md': 2, '稳.md': 1, '删.md': 4 },
        bases: { '改.md': '旧内容', '稳.md': '一样' },
      })
    );
    expect(summarize(list)).toEqual({ synced: 1, pending: 3, conflict: 0, total: 4 });
  });

  it('按路径中文序排，同一份库两次打开顺序一致', () => {
    const r = classifyVault(new Map([['乙.md', 'x'], ['甲.md', 'x']]), meta());
    expect(r.map((f) => f.path)).toEqual(['甲.md', '乙.md']);
  });

  it('空库汇总是全零', () => {
    expect(summarize([])).toEqual({ synced: 0, pending: 0, conflict: 0, total: 0 });
  });

  it('每种状态都有中文说明——面板和徽标共用同一份措辞', () => {
    for (const k of ['synced', 'new', 'modified', 'conflict', 'deleted'] as const) {
      expect(STATE_LABEL[k]).toBeTruthy();
    }
  });
});

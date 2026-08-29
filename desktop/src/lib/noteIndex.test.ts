import { describe, expect, it } from 'vitest';
import { diffIndex, isIndexable, type IndexEntry } from './noteIndex';

function idx(entries: [string, number, number, string][]): Map<string, IndexEntry> {
  return new Map(
    entries.map(([path, mtime, size, content]) => [path, { path, mtime, size, content }])
  );
}

describe('diffIndex', () => {
  it('空索引 → 全部要读', () => {
    const d = diffIndex(new Map(), [
      { path: 'a.md', mtime: 1, size: 10 },
      { path: 'b.md', mtime: 2, size: 20 },
    ]);
    expect(d.toRead.map((s) => s.path)).toEqual(['a.md', 'b.md']);
    expect(d.toDrop).toEqual([]);
  });

  it('指纹未变 → 一个都不重读（避免每次刷新全量读盘）', () => {
    const cur = idx([
      ['a.md', 1, 10, 'A'],
      ['b.md', 2, 20, 'B'],
    ]);
    const d = diffIndex(cur, [
      { path: 'a.md', mtime: 1, size: 10 },
      { path: 'b.md', mtime: 2, size: 20 },
    ]);
    expect(d.toRead).toEqual([]);
    expect(d.toDrop).toEqual([]);
  });

  it('mtime 变了 → 只重读变的那个', () => {
    const cur = idx([
      ['a.md', 1, 10, 'A'],
      ['b.md', 2, 20, 'B'],
    ]);
    const d = diffIndex(cur, [
      { path: 'a.md', mtime: 9, size: 10 },
      { path: 'b.md', mtime: 2, size: 20 },
    ]);
    expect(d.toRead.map((s) => s.path)).toEqual(['a.md']);
  });

  it('size 变了（mtime 相同）也要重读——有些文件系统 mtime 粒度是秒', () => {
    const cur = idx([['a.md', 1, 10, 'A']]);
    const d = diffIndex(cur, [{ path: 'a.md', mtime: 1, size: 11 }]);
    expect(d.toRead.map((s) => s.path)).toEqual(['a.md']);
  });

  it('文件消失 → 移出索引（否则删掉的笔记还会出现在搜索和反链里）', () => {
    const cur = idx([
      ['a.md', 1, 10, 'A'],
      ['gone.md', 1, 10, 'X'],
    ]);
    const d = diffIndex(cur, [{ path: 'a.md', mtime: 1, size: 10 }]);
    expect(d.toDrop).toEqual(['gone.md']);
    expect(d.toRead).toEqual([]);
  });

  it('改名 = 一进一出', () => {
    const cur = idx([['old.md', 1, 10, 'A']]);
    const d = diffIndex(cur, [{ path: 'new.md', mtime: 1, size: 10 }]);
    expect(d.toRead.map((s) => s.path)).toEqual(['new.md']);
    expect(d.toDrop).toEqual(['old.md']);
  });
});

describe('isIndexable', () => {
  it('只收 Markdown', () => {
    expect(isIndexable('a.md')).toBe(true);
    expect(isIndexable('a.markdown')).toBe(true);
    expect(isIndexable('a.pdf')).toBe(false);
    expect(isIndexable('Attachments/x.png')).toBe(false);
  });

  it('回收站里的不进索引', () => {
    expect(isIndexable('.trash/2026-01-01T00-00-00-a.md')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 快照持久化：目的是「启动别把整库重读一遍」，且过期/损坏必须自愈

import { loadIndexCache, saveIndexCache } from './noteIndex';
import type { FileIO } from './sync';

function fakeIO(files = new Map<string, string>()): { io: FileIO; files: Map<string, string> } {
  const io: FileIO = {
    async list() {
      return [...files.keys()];
    },
    async listMeta() {
      return [...files.keys()].map((p) => ({ path: p, mtime: 0, size: files.get(p)!.length }));
    },
    async read(_v, p) {
      const v = files.get(p);
      if (v === undefined) throw new Error('not found');
      return v;
    },
    async write(_v, p, c) {
      files.set(p, c);
    },
    async readBinary(_v, p) {
      return new TextEncoder().encode(files.get(p) ?? '');
    },
    async writeBinary(_v, p, d) {
      files.set(p, new TextDecoder().decode(d));
    },
    async remove(_v, p) {
      files.delete(p);
    },
    async exists(_v, p) {
      return files.has(p);
    },
  };
  return { io, files };
}

describe('索引快照', () => {
  it('存了能读回来', async () => {
    const { io } = fakeIO();
    const map = idx([
      ['a.md', 11, 2, 'A'],
      ['sub/b.md', 22, 3, 'BB'],
    ]);
    await saveIndexCache(io, '/vault', map);
    const back = await loadIndexCache(io, '/vault');
    expect(back.get('a.md')).toEqual({ path: 'a.md', mtime: 11, size: 2, content: 'A' });
    expect(back.get('sub/b.md')?.content).toBe('BB');
  });

  it('没有快照 → 空索引（全量重建，不是报错）', async () => {
    const { io } = fakeIO();
    expect((await loadIndexCache(io, '/vault')).size).toBe(0);
  });

  it('快照损坏 → 空索引，绝不抛异常把应用带崩', async () => {
    const { io, files } = fakeIO();
    files.set('.ivyea/cache/content.json', '{这不是合法 JSON');
    expect((await loadIndexCache(io, '/vault')).size).toBe(0);
  });

  it('快照版本不认 → 整份丢弃（格式升级时不能读出错内容）', async () => {
    const { io, files } = fakeIO();
    files.set('.ivyea/cache/content.json', JSON.stringify({ v: 999, entries: [['a.md', 1, 1, 'A']] }));
    expect((await loadIndexCache(io, '/vault')).size).toBe(0);
  });

  it('快照里混进了不该索引的路径 → 读回时过滤掉', async () => {
    const { io, files } = fakeIO();
    files.set(
      '.ivyea/cache/content.json',
      JSON.stringify({
        v: 1,
        entries: [
          ['ok.md', 1, 1, 'A'],
          ['.trash/x.md', 1, 1, 'B'],
          ['.ivyea/y.md', 1, 1, 'C'],
          ['pic.png', 1, 1, 'D'],
        ],
      })
    );
    const back = await loadIndexCache(io, '/vault');
    expect([...back.keys()]).toEqual(['ok.md']);
  });

  it('快照写不进去也不抛（磁盘满/只读时应用照常能用）', async () => {
    const { io } = fakeIO();
    const failing: FileIO = { ...io, async write() { throw new Error('disk full'); } };
    await expect(saveIndexCache(failing, '/vault', idx([['a.md', 1, 1, 'A']]))).resolves.toBeUndefined();
  });
});

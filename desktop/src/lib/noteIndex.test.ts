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

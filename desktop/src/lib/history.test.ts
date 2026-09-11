import { describe, it, expect } from 'vitest';
import {
  listSnapshots,
  parseSnapshotPath,
  pruneList,
  shouldSnapshot,
  snapshotBeforeWrite,
  snapshotPathFor,
  SNAPSHOT_MIN_GAP_MS,
} from './history';
import type { FileIO } from './sync';

/** 内存里的假库，只实现快照用到的几条 */
function memIO(files: Record<string, string> = {}): FileIO & { files: Record<string, string> } {
  return {
    files,
    async list() {
      return Object.keys(files);
    },
    async listMeta() {
      return Object.keys(files).map((path) => ({ path, mtime: 0, size: files[path].length }));
    },
    async read(_v, p) {
      if (!(p in files)) throw new Error('no ' + p);
      return files[p];
    },
    async write(_v, p, c) {
      files[p] = c;
    },
    async readBinary() {
      throw new Error('unused');
    },
    async writeBinary() {
      throw new Error('unused');
    },
    async remove(_v, p) {
      delete files[p];
    },
    async exists(_v, p) {
      return p in files;
    },
  };
}

const T0 = Date.UTC(2026, 8, 11, 2, 51, 37, 123);

describe('快照路径', () => {
  it('路径可反解，目录分隔符编码成 __，扩展名跟着笔记走', () => {
    const p = snapshotPathFor('亚马逊/周会计划/第一周.md', T0);
    expect(p).toBe('.ivyea/history/亚马逊__周会计划__第一周.md/2026-09-11T02-51-37-123.md');
    expect(parseSnapshotPath(p)).toEqual({ file: p, note: '亚马逊/周会计划/第一周.md', at: T0 });
  });
  it('不是快照的路径给 null', () => {
    expect(parseSnapshotPath('亚马逊/a.md')).toBeNull();
    expect(parseSnapshotPath('.ivyea/history/a.md/随便.md')).toBeNull();
    expect(parseSnapshotPath('.ivyea/cache/content.json')).toBeNull();
  });
});

describe('列表与节流', () => {
  it('只列这一篇的，新的在前', () => {
    const files = [
      snapshotPathFor('a.md', T0),
      snapshotPathFor('a.md', T0 + 1000),
      snapshotPathFor('b.md', T0 + 2000),
      'a.md',
    ];
    const got = listSnapshots(files, 'a.md');
    expect(got.map((s) => s.at)).toEqual([T0 + 1000, T0]);
  });
  it('5 分钟内不重复存', () => {
    const snaps = listSnapshots([snapshotPathFor('a.md', T0)], 'a.md');
    expect(shouldSnapshot(snaps, T0 + 1000)).toBe(false);
    expect(shouldSnapshot(snaps, T0 + SNAPSHOT_MIN_GAP_MS)).toBe(true);
    expect(shouldSnapshot([], T0)).toBe(true);
  });
  it('清理：超期的和超量的', () => {
    const day = 24 * 3600 * 1000;
    const snaps = listSnapshots(
      [snapshotPathFor('a.md', T0), snapshotPathFor('a.md', T0 - 31 * day), snapshotPathFor('a.md', T0 - 2 * day)],
      'a.md'
    );
    expect(pruneList(snaps, T0)).toEqual([snapshotPathFor('a.md', T0 - 31 * day)]);
    expect(pruneList(snaps, T0, { maxCount: 1 })).toEqual([
      snapshotPathFor('a.md', T0 - 2 * day),
      snapshotPathFor('a.md', T0 - 31 * day),
    ]);
  });
});

describe('snapshotBeforeWrite', () => {
  it('存的是覆盖之前盘上的旧内容', async () => {
    const io = memIO({ 'a.md': '旧内容' });
    const r = await snapshotBeforeWrite(io, '/v', 'a.md', '旧内容', Object.keys(io.files), T0);
    expect(r.written).toBe(snapshotPathFor('a.md', T0));
    expect(io.files[r.written!]).toBe('旧内容');
  });
  it('新文件（没有旧内容）不存', async () => {
    const io = memIO();
    const r = await snapshotBeforeWrite(io, '/v', 'a.md', null, [], T0);
    expect(r.written).toBeNull();
    expect(Object.keys(io.files)).toEqual([]);
  });
  it('内容和最近一张一样不存', async () => {
    const io = memIO({ 'a.md': 'x' });
    await snapshotBeforeWrite(io, '/v', 'a.md', 'x', Object.keys(io.files), T0);
    const r = await snapshotBeforeWrite(io, '/v', 'a.md', 'x', Object.keys(io.files), T0 + SNAPSHOT_MIN_GAP_MS);
    expect(r.written).toBeNull();
  });
  it('5 分钟内第二次不存；过了就存并清掉超量的', async () => {
    const io = memIO({ 'a.md': 'v1' });
    const all = () => Object.keys(io.files);
    expect((await snapshotBeforeWrite(io, '/v', 'a.md', 'v1', all(), T0)).written).not.toBeNull();
    expect((await snapshotBeforeWrite(io, '/v', 'a.md', 'v2', all(), T0 + 1000)).written).toBeNull();
    const r = await snapshotBeforeWrite(io, '/v', 'a.md', 'v2', all(), T0 + SNAPSHOT_MIN_GAP_MS);
    expect(r.written).not.toBeNull();
    expect(listSnapshots(all(), 'a.md')).toHaveLength(2);
  });
});

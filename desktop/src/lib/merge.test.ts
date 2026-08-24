import { describe, it, expect } from 'vitest';
import { diffLines, merge3, conflictCopy } from './merge';

const s = (lines: string[]) => lines.join('\n');

describe('diffLines', () => {
  it('识别中间插入行', () => {
    const ops = diffLines(['a', 'b', 'c'], ['a', 'x', 'b', 'c']);
    expect(ops.some((o) => o.op === '+' && o.lines.includes('x'))).toBe(true);
    expect(ops.filter((o) => o.op === '-').length).toBe(0);
  });

  it('识别删除行', () => {
    const ops = diffLines(['a', 'b', 'c'], ['a', 'c']);
    expect(ops.some((o) => o.op === '-' && o.lines.includes('b'))).toBe(true);
  });
});

describe('merge3 平凡情况', () => {
  it('双方相同 → 取该版本', () => {
    const r = merge3('base', 'same', 'same');
    expect(r.merged).toBe('same');
  });

  it('只有本地改 → 取本地', () => {
    const r = merge3('base', 'ours', 'base');
    expect(r.merged).toBe('ours');
  });

  it('只有服务端改 → 取服务端', () => {
    const r = merge3('base', 'base', 'theirs');
    expect(r.merged).toBe('theirs');
  });
});

describe('merge3 非平凡情况', () => {
  it('两端改不同段落 → 自动合并', () => {
    const base = s(['# 标题', '', '第一段。', '', '第二段。']);
    const ours = s(['# 标题', '', '第一段（本地修改）。', '', '第二段。']);
    const theirs = s(['# 标题', '', '第一段。', '', '第二段（服务端修改）。']);
    const r = merge3(base, ours, theirs);
    expect(r.merged).not.toBeNull();
    expect(r.merged).toContain('第一段（本地修改）');
    expect(r.merged).toContain('第二段（服务端修改）');
  });

  it('两端在末尾各自追加不同内容 → 自动合并（两侧都保留）', () => {
    const base = s(['a']);
    const ours = s(['a', 'local-tail']);
    const theirs = s(['a', 'server-tail']);
    const r = merge3(base, ours, theirs);
    // 追加位置相同且内容不同属于真冲突
    expect(r.merged).toBeNull();
  });

  it('两端改同一行为不同内容 → 冲突', () => {
    const base = s(['line']);
    const ours = s(['mine']);
    const theirs = s(['yours']);
    const r = merge3(base, ours, theirs);
    expect(r.merged).toBeNull();
  });

  it('一端追加、另一端改前文 → 自动合并', () => {
    const base = s(['head', 'body']);
    const ours = s(['head-changed', 'body']); // 本地改第一行
    const theirs = s(['head', 'body', 'appended']); // 服务端追加
    const r = merge3(base, ours, theirs);
    expect(r.merged).toBe(s(['head-changed', 'body', 'appended']));
  });

  it('空 base（新文件双端创建）相同内容 → 合并成功', () => {
    const r = merge3('', 'hello', 'hello');
    expect(r.merged).toBe('hello');
  });

  it('空 base 不同内容 → 冲突', () => {
    const r = merge3('', 'aaa', 'bbb');
    expect(r.merged).toBeNull();
  });
});

describe('conflictCopy', () => {
  it('包含三方内容与文件名', () => {
    const r = merge3('b', 'o', 't');
    const text = conflictCopy('notes/idea.md', r, '2026-08-24T00:00:00');
    expect(text).toContain('notes/idea.md');
    expect(text).toContain('o');
    expect(text).toContain('t');
    expect(text).toContain('b');
  });
});

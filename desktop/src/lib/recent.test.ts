import { describe, expect, it } from 'vitest';
import { orderByRecent, pushRecent } from './recent';

describe('pushRecent', () => {
  it('新打开的置顶', () => {
    expect(pushRecent(['a', 'b'], 'c')).toEqual(['c', 'a', 'b']);
  });
  it('重复打开只是提到最前，不产生重复项', () => {
    expect(pushRecent(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
  });
  it('超过上限截断', () => {
    const many = Array.from({ length: 60 }, (_, i) => `n${i}`);
    expect(pushRecent(many, 'x')).toHaveLength(50);
    expect(pushRecent(many, 'x')[0]).toBe('x');
  });
});

describe('orderByRecent', () => {
  const docs = [{ path: 'a.md' }, { path: 'b.md' }, { path: 'c.md' }];
  const p = (d: { path: string }) => d.path;

  it('最近打开的排前面', () => {
    expect(orderByRecent(docs, ['c.md', 'a.md'], p).map(p)).toEqual(['c.md', 'a.md', 'b.md']);
  });
  it('没打开过的保持原相对顺序排在后面', () => {
    expect(orderByRecent(docs, ['c.md'], p).map(p)).toEqual(['c.md', 'a.md', 'b.md']);
  });
  it('recent 里有已删除的路径也不影响（自动落选）', () => {
    expect(orderByRecent(docs, ['已删掉.md', 'b.md'], p).map(p)).toEqual(['b.md', 'a.md', 'c.md']);
  });
  it('空 recent 等于不排序', () => {
    expect(orderByRecent(docs, [], p).map(p)).toEqual(['a.md', 'b.md', 'c.md']);
  });
});

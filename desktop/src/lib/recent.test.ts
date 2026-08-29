import { describe, expect, it } from 'vitest';
import { orderByRecent, pushRecent, remapRecent } from './recent';

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

describe('remapRecent（改名/移动后修路径）', () => {
  it('把旧路径换成新路径，保持顺序', () => {
    const list = ['b.md', 'a.md', 'c.md'];
    expect(remapRecent(list, [{ from: 'a.md', to: '广告优化.md' }])).toEqual([
      'b.md',
      '广告优化.md',
      'c.md',
    ]);
  });

  it('标题跟随的真实场景：untitled.md 改名后不再留死路径', () => {
    const afterOpen = pushRecent([], 'untitled.md');
    const afterRename = remapRecent(afterOpen, [{ from: 'untitled.md', to: '广告优化.md' }]);
    // 紧接着新建第二篇，同样先叫 untitled.md
    const afterOpen2 = pushRecent(afterRename, 'untitled.md');
    const afterRename2 = remapRecent(afterOpen2, [{ from: 'untitled.md', to: '关键词研究.md' }]);
    expect(afterRename2).toEqual(['关键词研究.md', '广告优化.md']);
  });

  it('改名撞上历史里已有的同名条目时去重，保留靠前的位置', () => {
    expect(remapRecent(['a.md', 'b.md'], [{ from: 'a.md', to: 'b.md' }])).toEqual(['b.md']);
  });

  it('批量移动整个文件夹：子路径一起带走', () => {
    const list = ['日记/一.md', 'x.md', '日记/二.md'];
    const ops = [
      { from: '日记/一.md', to: '归档/日记/一.md' },
      { from: '日记/二.md', to: '归档/日记/二.md' },
    ];
    expect(remapRecent(list, ops)).toEqual(['归档/日记/一.md', 'x.md', '归档/日记/二.md']);
  });

  it('空 ops 原样返回（不改引用之外的行为）', () => {
    expect(remapRecent(['a.md'], [])).toEqual(['a.md']);
  });

  it('不在 recent 里的改名不产生新条目', () => {
    expect(remapRecent(['a.md'], [{ from: 'z.md', to: 'y.md' }])).toEqual(['a.md']);
  });
});

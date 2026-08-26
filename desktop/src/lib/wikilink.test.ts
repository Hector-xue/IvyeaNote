import { describe, expect, it } from 'vitest';
import { extractLinks, titleOfPath, buildBacklinks, renderWikiLinks } from './wikilink';

describe('extractLinks', () => {
  it('提取全部出链并去重', () => {
    expect(extractLinks('见 [[目标A]] 和 [[目标B|别名]] 与 [[目标A]]')).toEqual(['目标A', '目标B']);
  });
  it('无链接返回空', () => {
    expect(extractLinks('普通 [markdown](link) 文本')).toEqual([]);
  });
});

describe('titleOfPath', () => {
  it('basename 去后缀', () => {
    expect(titleOfPath('文章/引流.md')).toBe('引流');
    expect(titleOfPath('root.md')).toBe('root');
  });
});

describe('buildBacklinks', () => {
  it('反链索引：目标 → 引用者列表', () => {
    const titles = new Map([
      ['a.md', '目标A'],
      ['b.md', '目标B'],
      ['c.md', 'C'],
    ]);
    const docs = [
      { path: 'b.md', content: '引用 [[目标A]]' },
      { path: 'c.md', content: '也引用 [[目标A|别名]]' },
      { path: 'a.md', content: '引用 [[目标B]]' },
    ];
    const bl = buildBacklinks(docs, titles);
    expect(bl.get('a.md')).toEqual(['b.md', 'c.md']);
    expect(bl.get('b.md')).toEqual(['a.md']);
  });
  it('未创建的目标也记录（key 为目标名）', () => {
    const bl = buildBacklinks([{ path: 'x.md', content: '[[幽灵]]' }], new Map([['x.md', 'x']]));
    expect(bl.get('幽灵')).toEqual(['x.md']);
  });
});

describe('renderWikiLinks', () => {
  it('替换为可点链接', () => {
    const html = renderWikiLinks('<p>见 [[目标A]] 和 [[目标B|别名]]</p>', (t) => `#/note/${t}`);
    expect(html).toContain('data-target="目标A"');
    expect(html).toContain('>别名</a>');
    expect(html).toContain('href="#/note/目标B"');
  });
  it('转义目标中的引号', () => {
    const html = renderWikiLinks('[[a"b]]', (t) => t);
    expect(html).toContain('&quot;');
  });
});

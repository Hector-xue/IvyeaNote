import { describe, expect, it } from 'vitest';
import { extractTags, buildTagIndex } from './tags';

describe('extractTags', () => {
  it('正文 #标签', () => {
    expect(extractTags('今天聊 #亚马逊运营 和 #广告优化')).toEqual(['亚马逊运营', '广告优化']);
  });
  it('忽略标题与纯数字', () => {
    expect(extractTags('# 标题不是标签\n## 子标题\n值是 #123')).toEqual([]);
  });
  it('frontmatter tags 数组形式', () => {
    expect(extractTags('---\ntags: [a, b, "c"]\n---\n正文')).toEqual(['a', 'b', 'c']);
  });
  it('frontmatter tags 列表形式', () => {
    expect(extractTags('---\ntags:\n  - x\n  - y\ntitle: t\n---\n正文')).toEqual(['x', 'y']);
  });
  it('去重', () => {
    expect(extractTags('#a #a #b')).toEqual(['a', 'b']);
  });
});

describe('buildTagIndex', () => {
  it('标签到笔记列表', () => {
    const idx = buildTagIndex([
      { path: 'a.md', content: '#运营 #广告' },
      { path: 'b.md', content: '#运营' },
    ]);
    expect(idx.get('运营')).toEqual(['a.md', 'b.md']);
    expect(idx.get('广告')).toEqual(['a.md']);
  });
});

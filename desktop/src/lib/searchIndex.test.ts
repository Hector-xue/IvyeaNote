import { describe, expect, it } from 'vitest';
import { parseQuery, searchNotes } from './searchIndex';

const docs = [
  { path: '笔记.md', content: '# 笔记\n\n今天讨论亚马逊广告优化' },
  { path: '文章/引流.md', content: '小红书引流文案\n亚马逊选品思路' },
  { path: '文章/杂记.md', content: '随便记点什么\n关于广告的出价策略' },
];

describe('parseQuery', () => {
  it('解析短语与 path 过滤', () => {
    const q = parseQuery('"亚马逊 广告" path:文章 关键词');
    expect(q.phrase).toBe('亚马逊 广告');
    expect(q.pathFilter).toBe('文章');
    expect(q.text).toBe('关键词');
  });
  it('纯文本', () => {
    expect(parseQuery('hello world').text).toBe('hello world');
  });
});

describe('searchNotes', () => {
  it('标题命中加权高于正文', () => {
    const hits = searchNotes(
      [docs[0], { path: '亚马逊广告.md', content: '无关内容但标题匹配' }],
      '亚马逊'
    );
    expect(hits[0].path).toBe('亚马逊广告.md');
  });
  it('多词 AND 语义', () => {
    const hits = searchNotes(docs, '广告 出价');
    expect(hits.length).toBe(1);
    expect(hits[0].path).toBe('文章/杂记.md');
  });
  it('短语过滤', () => {
    const hits = searchNotes(docs, '"亚马逊选品"');
    expect(hits.length).toBe(1);
    expect(hits[0].path).toBe('文章/引流.md');
  });
  it('path 过滤', () => {
    const hits = searchNotes(docs, '广告 path:文章');
    expect(hits.every((h) => h.path.startsWith('文章/'))).toBe(true);
  });
  it('预览行包含命中内容', () => {
    const hits = searchNotes(docs, '引流');
    expect(hits[0].preview[0]).toContain('引流');
  });
  it('空查询返回空', () => {
    expect(searchNotes(docs, '')).toEqual([]);
    expect(searchNotes(docs, 'path:文章')).toEqual([]);
  });
});

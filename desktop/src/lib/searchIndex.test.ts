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
    expect(hits[0].preview[0].text).toContain('引流');
  });
  it('预览行带 1 起的行号——侧栏搜索点它要能跳到那一行（E7）', () => {
    const hits = searchNotes(
      [{ path: 'a.md', content: '# 标题\n无关\n这里有引流\n' }],
      '引流'
    );
    expect(hits[0].preview[0].line).toBe(3);
  });
  it('空查询返回空', () => {
    expect(searchNotes(docs, '')).toEqual([]);
    expect(searchNotes(docs, 'path:文章')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// v0.8.0 倒排索引 + BM25 带来的新行为

describe('BM25 排序（v0.8.0）', () => {
  it('罕见词权重高于常见词：只含罕见词的笔记排在前面', () => {
    const corpus = [
      { path: '甲.md', content: '广告 广告 广告 广告 广告' }, // 常见词，出现多次
      { path: '乙.md', content: '广告 鹦鹉螺' }, // 含罕见词
      { path: '丙.md', content: '广告 优化' },
      { path: '丁.md', content: '广告 出价' },
    ];
    const hits = searchNotes(corpus, '广告 鹦鹉螺');
    expect(hits[0].path).toBe('乙.md');
  });

  it('长度归一化：同样命中一次，短文排在长文前面（旧实现相反）', () => {
    const long = '无关内容 '.repeat(200) + '独特词';
    const corpus = [
      { path: '长文.md', content: long },
      { path: '短文.md', content: '独特词' },
    ];
    const hits = searchNotes(corpus, '独特词');
    expect(hits.map((h) => h.path)).toEqual(['短文.md', '长文.md']);
  });
});

describe('单字 CJK 查询（前缀展开）', () => {
  it('搜单个字能命中包含它的词', () => {
    const corpus = [
      { path: 'a.md', content: '猫粮很贵' },
      { path: 'b.md', content: '完全无关' },
    ];
    const hits = searchNotes(corpus, '猫');
    expect(hits.map((h) => h.path)).toEqual(['a.md']);
  });
});

describe('tag: 过滤（v0.8.0 新增）', () => {
  const corpus = [
    { path: 'x.md', content: '广告策略 #亚马逊' },
    { path: 'y.md', content: '广告策略 #小红书' },
  ];
  it('按标签收窄', () => {
    const hits = searchNotes(corpus, '广告 tag:亚马逊');
    expect(hits.map((h) => h.path)).toEqual(['x.md']);
  });
  it('带 # 前缀也认', () => {
    expect(searchNotes(corpus, '广告 tag:#小红书').map((h) => h.path)).toEqual(['y.md']);
  });
});

describe('规模与速度', () => {
  it('2000 篇笔记检索在 50ms 内返回（旧实现要全量扫正文）', () => {
    const corpus = Array.from({ length: 2000 }, (_, i) => ({
      path: `n${i}.md`,
      content: `第 ${i} 篇 亚马逊广告优化 出价策略 关键词研究 `.repeat(20),
    }));
    corpus[1234].content += ' 独一无二的稀有词';
    searchNotes(corpus, '预热'); // 先建索引，不计入
    const t0 = performance.now();
    const hits = searchNotes(corpus, '稀有');
    const ms = performance.now() - t0;
    expect(hits[0].path).toBe('n1234.md');
    expect(ms).toBeLessThan(50);
  });
});

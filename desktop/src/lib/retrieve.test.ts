/**
 * 取材层的用例（v0.11.20）。
 *
 * 这一层决定「问整个笔记库」答得对不对——模型再强，喂错了材料也只能编。
 * 所以锁死的是三件事：**该找到的找得到**（OR 语义，不是搜索框那套 AND）、
 * **发出去的量可控**（字数上限真的生效），以及 **截的是相关的那一段**（不是开头）。
 */
import { describe, expect, it } from 'vitest';
import { bestWindow, retrieve, totalChars } from './retrieve';

const docs = [
  {
    path: '商业/定价策略.md',
    content: ['# 定价策略', '', '我们最后定的是三档订阅：基础 29、专业 99、团队 299。', '毛利率目标 70%。'].join('\n'),
  },
  {
    path: '日记/2026-03-02.md',
    content: ['今天很累，中午吃了面。', '下午和团队聊了一会儿。'].join('\n'),
  },
  {
    path: '技术/索引重写.md',
    content: ['把全库扫描换成倒排索引 + BM25。', '一万篇的查询从几百毫秒降到十几毫秒。'].join('\n'),
  },
];

describe('retrieve', () => {
  /*
   * 这条是这一层存在的理由。`searchNotes` 是 AND 语义：一句问话切出十几个二元组，
   * 没有哪篇会全中，结果是零命中——模型拿不到任何材料，只好开始编。
   */
  it('整句问话也能命中（OR 打分，不是所有词都得中）', () => {
    const hits = retrieve(docs, '我之前关于定价那套结论是什么来着？');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].path).toBe('商业/定价策略.md');
  });

  it('毫不相关的笔记不进结果（宁可少给，不能给错的材料）', () => {
    const paths = retrieve(docs, '定价 毛利率').map((h) => h.path);
    expect(paths).toContain('商业/定价策略.md');
    expect(paths).not.toContain('日记/2026-03-02.md');
  });

  it('一个词都不沾就返回空——上层据此提示"换个说法"，而不是硬发一次请求', () => {
    expect(retrieve(docs, 'xylophone')).toEqual([]);
  });

  it('标题命中额外加权（笔记名就叫这个，几乎必然相关）', () => {
    const hits = retrieve(docs, '索引重写');
    expect(hits[0].path).toBe('技术/索引重写.md');
  });

  it('按篇数与总字数封顶——一次问答的成本必须是可预期的', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      path: `n/${i}.md`,
      content: `定价 定价 定价\n${'正'.repeat(3000)}`,
    }));
    const hits = retrieve(many, '定价', { maxDocs: 3, maxCharsPerDoc: 500, maxTotalChars: 1200 });
    expect(hits.length).toBeLessThanOrEqual(3);
    expect(totalChars(hits)).toBeLessThanOrEqual(1200);
  });

  it('空问题 / 空库都不炸', () => {
    expect(retrieve(docs, '   ')).toEqual([]);
    expect(retrieve([], '定价')).toEqual([]);
  });
});

describe('bestWindow', () => {
  it('截的是命中那一段，不是开头', () => {
    const content = ['开头无关的一段。', '中间无关的一段。', '结论：毛利率目标 70%。', '后面还有别的。'].join('\n');
    // 预算刚好只装得下命中那一行：装得下更多时把上下文一起带上是对的，
    // 这条要验的是"选谁当中心"，所以把预算卡死
    const win = bestWindow(content, ['毛利'], 20);
    expect(win.text).toBe('结论：毛利率目标 70%。');
    expect(win.line).toBe(3);
  });

  it('一个词都没命中（只有标题命中）时给开头——开头通常说明这篇在讲什么', () => {
    const win = bestWindow('第一行。\n第二行。', ['完全没有的词'], 100);
    expect(win.text.startsWith('第一行')).toBe(true);
    expect(win.line).toBe(1);
  });

  it('按行扩，不从句子中间切开', () => {
    const content = ['一二三四五', '定价在这里', '六七八九十'].join('\n');
    const win = bestWindow(content, ['定价'], 100);
    expect(win.text.split('\n').every((l) => content.includes(l))).toBe(true);
  });

  it('预算小到只装得下一行时也不越界', () => {
    const win = bestWindow(['很长很长很长的一行'.repeat(5), '定价'].join('\n'), ['定价'], 10);
    expect(win.text.length).toBeLessThanOrEqual(12);
  });
});

import { describe, expect, it } from 'vitest';
import { countWords } from './wordCount';

describe('countWords', () => {
  it('中文字符逐字计数', () => {
    expect(countWords('你好世界').words).toBe(4);
  });
  it('英文按词计数', () => {
    expect(countWords('hello world foo').words).toBe(3);
  });
  it('中英混排', () => {
    expect(countWords('你好 world').words).toBe(3);
  });
  // v0.11.11：口径随 Obsidian 改。旧的两条断言（字符去空白、代码块不计）
  // 正是与 Obsidian 差 9,803 个字符的原因，已按实测改写。
  it('字符数 = 原文长度（含空白）', () => {
    expect(countWords('a b\nc').characters).toBe(5);
  });
  it('代码块计入词数', () => {
    const r = countWords('前\n```\ncode block here\n```\n后');
    expect(r.words).toBe(5); // 前 + code + block + here + 后
  });
  it('空文档', () => {
    expect(countWords('')).toEqual({ words: 0, characters: 0 });
  });
  it('Markdown 标记中的词照常统计（与 Obsidian 一致的近似）', () => {
    expect(countWords('- [ ] 任务一').words).toBeGreaterThanOrEqual(3);
  });
});

/**
 * v0.11.11：口径改成与 Obsidian 一致。
 * 这几条是拿用户那篇真文档（Obsidian 报 6,158 词 / 25,251 字符）比对出来的规则。
 */
describe('与 Obsidian 对齐的口径（v0.11.11）', () => {
  it('字符数 = 原文长度：空白、换行、Markdown 语法都算', () => {
    const md = '# 标题\n\n正文 abc\n';
    expect(countWords(md).characters).toBe(md.length);
  });

  it('代码块也计入（旧实现整段剔掉，这是与 Obsidian 差最多的一项）', () => {
    const withCode = '正文\n\n```js\nconst a = 1;\n```\n';
    const r = countWords(withCode);
    expect(r.characters).toBe(withCode.length);
    expect(r.words).toBeGreaterThan(countWords('正文\n').words);
  });

  it('数字里的小数点与千分位不断词', () => {
    expect(countWords('18.06').words).toBe(1);
    expect(countWords('1,000').words).toBe(1);
    expect(countWords('第 1.1 节').words).toBe(cnWords('第 节') + 1);
  });

  it('中文按字、英文按词', () => {
    expect(countWords('你好 world').words).toBe(3);
  });
});

/** 只数中文字，供上面那条断言用 */
function cnWords(s: string): number {
  return (s.match(/[\u4e00-\u9fff]/g) ?? []).length;
}

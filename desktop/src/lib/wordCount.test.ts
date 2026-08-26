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
  it('字符数去空白', () => {
    expect(countWords('a b\nc').characters).toBe(3);
  });
  it('代码块不计入', () => {
    const r = countWords('前\n```\ncode block here\n```\n后');
    expect(r.words).toBe(2);
  });
  it('空文档', () => {
    expect(countWords('')).toEqual({ words: 0, characters: 0 });
  });
  it('Markdown 标记中的词照常统计（与 Obsidian 一致的近似）', () => {
    expect(countWords('- [ ] 任务一').words).toBeGreaterThanOrEqual(3);
  });
});

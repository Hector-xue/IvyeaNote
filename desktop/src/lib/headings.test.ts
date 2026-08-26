import { describe, expect, it } from 'vitest';
import { extractHeadings } from './headings';

describe('extractHeadings', () => {
  it('提取各级标题及其偏移', () => {
    const md = '# A\n\nsome text\n## B\n### C\n';
    const hs = extractHeadings(md);
    expect(hs).toEqual([
      { level: 1, text: 'A', offset: 0 },
      { level: 2, text: 'B', offset: 15 },
      { level: 3, text: 'C', offset: 20 },
    ]);
  });

  it('忽略代码块内的 # 行', () => {
    const md = '# Real\n```\n# not a heading\n```\n## After\n';
    const hs = extractHeadings(md);
    expect(hs.map((h) => h.text)).toEqual(['Real', 'After']);
  });

  it('忽略无空格的 # 与尾随 #', () => {
    const hs = extractHeadings('#NotHeading\n## Titled ##\n');
    expect(hs.length).toBe(1);
    expect(hs[0].text).toBe('Titled');
  });

  it('空文档返回空数组', () => {
    expect(extractHeadings('')).toEqual([]);
  });
});

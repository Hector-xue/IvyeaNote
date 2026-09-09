import { describe, expect, it } from 'vitest';
import { extractTags } from './tags';
import { mergeTags, normalizeTags, parseTagReply } from './noteTags';

describe('parseTagReply', () => {
  it('认 `#a #b` 这种最常见的回复', () => {
    expect(parseTagReply('#定价 #毛利率 #订阅')).toEqual(['定价', '毛利率', '订阅']);
  });
  it('模型不听话用逗号或换行分隔时也认', () => {
    expect(parseTagReply('定价, 毛利率，订阅')).toEqual(['定价', '毛利率', '订阅']);
    expect(parseTagReply('定价\n毛利率\n')).toEqual(['定价', '毛利率']);
  });
  it('去重、去井号、去空白', () => {
    expect(normalizeTags([' #定价 ', '定价', '', '  '])).toEqual(['定价']);
  });
});

describe('mergeTags', () => {
  it('没有 frontmatter 就在最前面建一段，正文一个字不动', () => {
    const r = mergeTags('# 标题\n\n正文', ['定价']);
    expect(r.content.startsWith('---\ntags: [定价]\n---\n\n# 标题')).toBe(true);
    expect(r.content).toContain('正文');
    expect(r.added).toEqual(['定价']);
  });

  /* 只增不删：模型漏想到的不等于用户不要 */
  it('已有的标签一个都不动，只把新的补上', () => {
    const src = '---\ntags: [已有, 定价]\n---\n\n正文';
    const r = mergeTags(src, ['定价', '毛利率']);
    expect(r.added).toEqual(['毛利率']);
    expect(r.content).toContain('tags: [已有, 定价, 毛利率]');
  });

  it('一个新的都没有时原样返回（上层据此说"已经都有了"）', () => {
    const src = '---\ntags: [定价]\n---\n正文';
    const r = mergeTags(src, ['定价']);
    expect(r.added).toEqual([]);
    expect(r.content).toBe(src);
  });

  /* 跟着这篇笔记已有的写法走——改写法等于替用户做决定，diff 也会很难看 */
  it('块状写法继续补行，缩进照抄上一行', () => {
    const src = '---\ntitle: 甲\ntags:\n  - 已有\n---\n\n正文';
    const r = mergeTags(src, ['定价']);
    expect(r.content).toContain('  - 已有\n  - 定价');
    expect(r.content).not.toContain('tags: [');
  });

  it('有 frontmatter 但没有 tags：补一行，别的字段不动', () => {
    const r = mergeTags('---\ntitle: 甲\n---\n\n正文', ['定价']);
    expect(r.content).toContain('title: 甲');
    expect(r.content).toContain('tags: [定价]');
  });

  it('空标签列表什么都不做', () => {
    const src = '正文';
    expect(mergeTags(src, []).content).toBe(src);
    expect(mergeTags(src, ['   ', '#']).content).toBe(src);
  });

  /*
   * 写进去的东西，标签面板得认得出来——两个模块各写各的解析，
   * 迟早会长成"写进去了但搜不到"。
   */
  it('写出来的形状，lib/tags 解析得出来（四种起点都试一遍）', () => {
    const cases = [
      '# 标题\n正文',
      '---\ntags: [已有]\n---\n正文',
      '---\ntags:\n  - 已有\n---\n正文',
      '---\ntitle: 甲\n---\n正文',
    ];
    for (const src of cases) {
      const out = mergeTags(src, ['定价', '毛利率']).content;
      const got = extractTags(out);
      expect(got).toContain('定价');
      expect(got).toContain('毛利率');
    }
  });
});

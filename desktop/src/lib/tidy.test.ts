/**
 * 排版整理是**确定性**的那一半（另一半是 AI，见 llm.ts）。既然确定，就必须能单测到
 * 每一条规则——尤其是「什么不该动」：把规则套到代码块、链接地址、frontmatter 上
 * 就是破坏用户的文件，而这种破坏往往要等同步到另一台设备才被发现。
 */
import { describe, expect, it } from 'vitest';
import { tidyMarkdown, describeTidy } from './tidy';

const NL = '\n';

describe('排版整理：该动的', () => {
  it('中英文之间补空格（两个方向都补）', () => {
    const r = tidyMarkdown('用 Obsidian的人很多，ACOS指标也要看' + NL);
    expect(r.text).toContain('Obsidian 的人');
    expect(r.text).toContain('ACOS 指标');
    expect(r.report.spaced).toBeGreaterThan(0);
  });

  it('中文之间的半角标点换成全角', () => {
    const r = tidyMarkdown('先看数据,再动出价;别一次改两个变量' + NL);
    expect(r.text).toContain('数据，再动');
    expect(r.text).toContain('，');
    expect(r.text).toContain('；');
  });

  it('列表符号统一成 -', () => {
    const r = tidyMarkdown(['* 甲', '+ 乙', '- 丙'].join(NL) + NL);
    expect(r.text.split(NL).filter((l) => l.startsWith('- ')).length).toBe(3);
    expect(r.report.listMarkers).toBe(2);
  });

  it('标题不许跳级：H2 后面的 H4 降成 H3', () => {
    const r = tidyMarkdown(['## 二级', '', '#### 四级'].join(NL) + NL);
    expect(r.text).toContain('### 四级');
    expect(r.report.headings).toBe(1);
  });

  it('连续空行收成一行，文件末尾恰好一个换行', () => {
    const r = tidyMarkdown('甲' + NL + NL + NL + NL + '乙' + NL + NL + NL);
    expect(r.text).toBe('甲' + NL + NL + '乙' + NL);
  });
});

describe('排版整理：**不该动**的', () => {
  it('围栏代码块里一个字节都不动', () => {
    const src = ['```js', 'const a=1,b=2;// 中文comment', '```'].join(NL) + NL;
    expect(tidyMarkdown(src).text).toBe(src);
  });

  it('行内代码与链接地址不动', () => {
    const src = '见 `npm run build`和 [文档](https://a.com/x_y-z)里的说明' + NL;
    const out = tidyMarkdown(src).text;
    expect(out).toContain('`npm run build`');
    expect(out).toContain('(https://a.com/x_y-z)');
  });

  it('frontmatter 原样保留', () => {
    const src = ['---', 'title: 甲,乙', 'tags: [a,b]', '---', '', '正文' + NL].join(NL);
    const out = tidyMarkdown(src).text;
    expect(out).toContain('title: 甲,乙');
    expect(out).toContain('tags: [a,b]');
  });

  it('表格分隔行与缩进代码块不动', () => {
    const src = ['| 甲 | 乙 |', '| --- | :--: |', '', '    code,line', ''].join(NL);
    const out = tidyMarkdown(src).text;
    expect(out).toContain('| --- | :--: |');
    expect(out).toContain('    code,line');
  });

  it('版本号里的点不会被当成句号', () => {
    const r = tidyMarkdown('升级到 v1.2.3 之后再看' + NL);
    expect(r.text).toContain('v1.2.3');
    expect(r.text).not.toContain('1。2');
  });

  it('本来就规范的文本不产生任何改动', () => {
    const src = ['# 标题', '', '这是一段中文，混着 English 词。', '', '- 甲', '- 乙', ''].join(NL);
    const r = tidyMarkdown(src);
    expect(r.changed).toBe(false);
    expect(describeTidy(r.report)).toBeNull();
  });
});

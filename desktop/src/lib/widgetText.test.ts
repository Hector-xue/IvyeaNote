import { describe, expect, it } from 'vitest';
import { widgetPreview, PREVIEW_MAX } from './widgetText';

describe('widgetPreview', () => {
  it('去掉 frontmatter、标题井号与强调记号', () => {
    const md = '---\ntags: [a]\n---\n# 每周复盘\n\n这周 **很忙**，_但_ 有 `进展`。';
    expect(widgetPreview(md)).toBe('每周复盘\n\n这周 很忙，但 有 进展。');
  });

  it('任务框变成 ☐ / ☑，普通列表变成 •，有序列表保留数字', () => {
    const md = '- [ ] 回邮件\n- [x] 发票\n- 买菜\n1. 第一\n  * 子项';
    expect(widgetPreview(md)).toBe('☐ 回邮件\n☑ 发票\n• 买菜\n1. 第一\n  • 子项');
  });

  it('链接留文字、图片整个去掉、双链取显示名或文件名', () => {
    const md = '看 [官网](https://x.y) 和 ![图](a/b.png) 以及 [[目录/笔记.md|别名]] [[另一篇]]';
    expect(widgetPreview(md)).toBe('看 官网 和  以及 别名 另一篇');
  });

  it('代码围栏去标记留内容；引用去掉 >；分隔线整行去掉；连续空行压缩', () => {
    const md = '```sh\nnpm run build\n```\n\n\n\n> 引用\n\n---\n\n结尾\n\n';
    expect(widgetPreview(md)).toBe('npm run build\n\n引用\n\n结尾');
  });

  it('超长按上限截断并加省略号', () => {
    const md = 'x'.repeat(PREVIEW_MAX + 100);
    const got = widgetPreview(md);
    expect(got.length).toBe(PREVIEW_MAX);
    expect(got.endsWith('…')).toBe(true);
  });

  it('空笔记 → 空串（卡片那边会显示"这篇还是空的"）', () => {
    expect(widgetPreview('')).toBe('');
    expect(widgetPreview('\n\n# \n')).toBe('');
  });

  it('Windows 换行也能处理', () => {
    expect(widgetPreview('a\r\nb\r\n\r\n\r\nc')).toBe('a\nb\n\nc');
  });
});

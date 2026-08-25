// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './MarkdownEditor';

describe('renderMarkdown（阅读模式渲染）', () => {
  it('标题/加粗/列表渲染为 HTML', () => {
    const html = renderMarkdown('# 标题\n\n**加粗** 和 *斜体*\n\n- a\n- b');
    expect(html).toContain('<h1>');
    expect(html).toContain('<strong>加粗</strong>');
    expect(html).toContain('<em>斜体</em>');
    expect(html).toContain('<li>a</li>');
  });

  it('任务列表渲染 checkbox', () => {
    const html = renderMarkdown('- [x] 完成\n- [ ] 待办');
    expect(html).toContain('type="checkbox"');
  });

  it('XSS 被 DOMPurify 过滤', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">正常文字');
    expect(html).not.toContain('onerror');
    expect(html).toContain('正常文字');
  });

  it('相对图片路径保留（由组件异步替换为 blob URL）', () => {
    const html = renderMarkdown('![pic](Attachments/pic.png)');
    expect(html).toContain('Attachments/pic.png');
  });
});

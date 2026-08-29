// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { decorateCallouts, renderMarkdown } from './MarkdownEditor';

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

describe('阅读态 callout（v0.8.5 E5）', () => {
  it('> [!note] 变成带类型的 blockquote，且不再露出 [!note] 字面量', () => {
    const html = renderMarkdown('> [!note] 提醒\n> 正文');
    expect(html).toContain('class="callout callout-note"');
    expect(html).not.toContain('[!note]');
  });

  it('类型大小写归一', () => {
    expect(renderMarkdown('> [!WARNING] x')).toContain('callout-warning');
  });

  it('普通引用不受影响', () => {
    const html = renderMarkdown('> 只是引用');
    expect(html).toContain('<blockquote>');
    expect(html).not.toContain('callout');
  });

  it('只改 class 和去掉标记，不注入新标签', () => {
    const before = '<blockquote>\n<p>[!tip] 小贴士</p>\n</blockquote>';
    expect(decorateCallouts(before)).toBe(
      '<blockquote class="callout callout-tip"><p>小贴士</p>\n</blockquote>'
    );
  });

  it('正文里出现的 [!note] 文本不会被误改（它不在 blockquote 开头）', () => {
    const html = renderMarkdown('这里提到 [!note] 三个字');
    expect(html).not.toContain('callout');
  });
});

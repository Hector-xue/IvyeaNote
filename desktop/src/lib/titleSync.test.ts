import { describe, it, expect } from 'vitest';
import { extractH1, replaceFirstH1, sanitizeTitle, titleToPath, uniqueName } from './titleSync';

describe('extractH1', () => {
  it('提取首个 H1', () => {
    expect(extractH1('# Hello\n\nbody')).toBe('Hello');
    expect(extractH1('pre text\n# 标题\n## 子')).toBe(null); // H1 前有正文则不认
  });

  it('跳过代码块内的 #', () => {
    expect(extractH1('```\n# not a heading\n```\n# Real')).toBe('Real');
  });

  it('清洗行内格式与 wiki 链接', () => {
    expect(extractH1('# **加粗** 和 `code`')).toBe('加粗 和 code');
    expect(extractH1('# [[目标|别名]]')).toBe('别名');
  });

  it('无 H1 返回 null', () => {
    expect(extractH1('')).toBe(null);
    expect(extractH1('## only h2')).toBe(null);
  });
});

describe('sanitizeTitle', () => {
  it('去掉非法字符', () => {
    expect(sanitizeTitle('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij');
    expect(sanitizeTitle('  hello  world. ')).toBe('hello world');
  });
  it('空标题回退 untitled', () => {
    expect(sanitizeTitle('///')).toBe('untitled');
  });
  it('限制长度 80', () => {
    expect(sanitizeTitle('x'.repeat(200)).length).toBe(80);
  });
});

describe('titleToPath', () => {
  it('保留目录，替换 basename', () => {
    expect(titleToPath('notes/old name.md', '新标题')).toBe('notes/新标题.md');
    expect(titleToPath('root.md', 'abc')).toBe('abc.md');
  });
});

describe('uniqueName', () => {
  it('无冲突直接用', () => {
    expect(uniqueName('untitled', [])).toBe('untitled.md');
  });
  it('冲突自动序号', () => {
    const ex = ['untitled.md', 'untitled 1.md'];
    expect(uniqueName('untitled', ex)).toBe('untitled 2.md');
  });
});

/*
 * 2026-09-08 用户：「文档还无法自定义标题，默认使用文档第一行的大标题为文档标题，
 * 改了又自动改回去」。改名时把正文 H1 一起带上，单向同步就不会再把它拽回去。
 */
describe('replaceFirstH1', () => {
  it('换掉第一个 H1，其余一个字不动', () => {
    const md = '# 旧标题\n\n正文\n\n# 后面的另一个一级标题\n';
    expect(replaceFirstH1(md, '新标题')).toBe(
      '# 新标题\n\n正文\n\n# 后面的另一个一级标题\n'
    );
  });

  it('没有 H1 就原样返回（不给用户凭空插一行）', () => {
    const md = '正文开头就没有标题\n';
    expect(replaceFirstH1(md, '新标题')).toBe(md);
  });

  it('围栏代码块里的 # 不算标题', () => {
    const md = '```\n# 这是代码\n```\n\n# 真标题\n';
    expect(replaceFirstH1(md, '新')).toBe('```\n# 这是代码\n```\n\n# 新\n');
  });

  it('改完之后 extractH1 读出来就是新标题（两边不会再打架）', () => {
    const next = replaceFirstH1('# 旧\n\n正文\n', '我的自定义标题');
    expect(extractH1(next)).toBe('我的自定义标题');
  });
});

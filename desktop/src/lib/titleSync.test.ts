import { describe, it, expect } from 'vitest';
import { extractH1, sanitizeTitle, titleToPath, uniqueName } from './titleSync';

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

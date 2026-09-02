import { describe, expect, it } from 'vitest';
import { classifyLink, headingSlug, noteCandidates, resolveVaultPath } from './links';

describe('classifyLink', () => {
  it('识别 http/https 为外部', () => {
    expect(classifyLink('https://example.com/a').kind).toBe('external');
    expect(classifyLink('http://example.com').kind).toBe('external');
  });

  it('mailto / tel 也走系统', () => {
    expect(classifyLink('mailto:a@b.com')).toEqual({ kind: 'external', target: 'mailto:a@b.com' });
    expect(classifyLink('tel:12345').kind).toBe('external');
  });

  it('协议相对地址补成 https（漏判会被当成库内路径）', () => {
    expect(classifyLink('//cdn.example.com/x.js')).toEqual({
      kind: 'external',
      target: 'https://cdn.example.com/x.js',
    });
  });

  it('不认识的 scheme 一律当外部，不当库内路径', () => {
    expect(classifyLink('obsidian://open?vault=x').kind).toBe('external');
  });

  it('# 开头是页内锚点', () => {
    expect(classifyLink('#第二节')).toEqual({ kind: 'anchor', target: '第二节' });
  });

  it('.md 与无后缀都是笔记', () => {
    expect(classifyLink('子目录/今天.md')).toEqual({ kind: 'note', target: '子目录/今天.md' });
    expect(classifyLink('某笔记')).toEqual({ kind: 'note', target: '某笔记' });
  });

  it('其它后缀是附件', () => {
    expect(classifyLink('Attachments/图.png').kind).toBe('asset');
    expect(classifyLink('手册.pdf').kind).toBe('asset');
  });

  it('相对链接后面的 query/hash 不参与后缀判定', () => {
    expect(classifyLink('笔记.md#小节')).toEqual({ kind: 'note', target: '笔记.md' });
  });

  it('空 href 不炸', () => {
    expect(classifyLink('').kind).toBe('anchor');
  });
});

describe('resolveVaultPath', () => {
  it('相对当前笔记所在目录，而不是库根', () => {
    expect(resolveVaultPath('项目/周报.md', '图.png')).toBe('项目/图.png');
  });

  it('消化 ../ 与 ./', () => {
    expect(resolveVaultPath('a/b/c.md', '../d/e.md')).toBe('a/d/e.md');
    expect(resolveVaultPath('a/b/c.md', './e.md')).toBe('a/b/e.md');
  });

  it('前导 / 表示库根，不是磁盘根', () => {
    expect(resolveVaultPath('a/b/c.md', '/顶层.md')).toBe('顶层.md');
  });

  it('URL 解码中文文件名', () => {
    expect(resolveVaultPath(null, '%E4%B8%AD%E6%96%87.md')).toBe('中文.md');
  });

  it('半截百分号编码不抛异常', () => {
    expect(resolveVaultPath(null, '坏%.md')).toBe('坏%.md');
  });

  it('切掉 hash 再解析', () => {
    expect(resolveVaultPath('a/b.md', 'c.md#节')).toBe('a/c.md');
  });

  it('当前笔记在库根时不加前缀', () => {
    expect(resolveVaultPath('顶层.md', '别的.md')).toBe('别的.md');
  });
});

describe('noteCandidates', () => {
  it('无后缀时优先试 .md', () => {
    expect(noteCandidates('某笔记')).toEqual(['某笔记.md', '某笔记.markdown', '某笔记']);
  });

  it('已带后缀就只有它自己', () => {
    expect(noteCandidates('a/b.md')).toEqual(['a/b.md']);
  });
});

describe('headingSlug', () => {
  it('空格转连字符并小写', () => {
    expect(headingSlug('Hello World')).toBe('hello-world');
  });

  it('中文原样保留', () => {
    expect(headingSlug('第二节 要点')).toBe('第二节-要点');
  });

  it('标点去掉', () => {
    expect(headingSlug('为什么？（重要）')).toBe('为什么重要');
  });
});

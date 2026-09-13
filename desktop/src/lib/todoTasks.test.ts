import { describe, expect, it } from 'vitest';
import { collectTasks, tasksOf, toggleTaskLine } from './todoTasks';

describe('tasksOf', () => {
  it('只收未完成的任务行，行号 0 起，原文与展示文分开', () => {
    const md = '# 标题\n- [ ] **回邮件** 给 [供应商](x)\n- [x] 做完了\n* [ ] 拍主图\n1. [ ] 有序也算\n- 普通列表\n';
    const t = tasksOf('a.md', 'a', md);
    expect(t.map((x) => [x.line, x.raw, x.text])).toEqual([
      [1, '**回邮件** 给 [供应商](x)', '回邮件 给 供应商'],
      [3, '拍主图', '拍主图'],
      [4, '有序也算', '有序也算'],
    ]);
  });

  it('代码块里的 "- [ ]" 不算；CRLF 也能数对行号', () => {
    const md = '```\r\n- [ ] 这是代码\r\n```\r\n- [ ] 真的\r\n';
    expect(tasksOf('a.md', 'a', md).map((x) => [x.line, x.raw])).toEqual([[3, '真的']]);
  });
});

describe('collectTasks', () => {
  it('按笔记修改时间新的在前，同一篇按行号；跳过回收站和元数据目录；封顶', () => {
    const docs = [
      { path: 'old.md', content: '- [ ] o1\n- [ ] o2' },
      { path: 'new.md', content: '- [ ] n1' },
      { path: '.trash/x.md', content: '- [ ] 垃圾' },
      { path: 'img.png', content: '- [ ] 不是笔记' },
    ];
    const mt: Record<string, number> = { 'old.md': 1, 'new.md': 9, '.trash/x.md': 99 };
    const all = collectTasks(docs, (p) => mt[p] ?? 0, (p) => p.replace(/\.md$/, ''));
    expect(all.map((t) => `${t.title}:${t.raw}`)).toEqual(['new:n1', 'old:o1', 'old:o2']);
    expect(collectTasks(docs, (p) => mt[p] ?? 0, (p) => p, 2)).toHaveLength(2);
  });
});

describe('toggleTaskLine', () => {
  it('行号对得上就改那一行', () => {
    expect(toggleTaskLine('- [ ] a\n- [ ] b\n', 1, 'b')).toBe('- [ ] a\n- [x] b\n');
  });

  it('行号漂了：全文唯一一条同原文的就改它；不唯一或没有都不动', () => {
    expect(toggleTaskLine('前面插了一行\n- [ ] a\n- [ ] b\n', 1, 'b')).toBe('前面插了一行\n- [ ] a\n- [x] b\n');
    expect(toggleTaskLine('- [ ] b\n- [ ] b\n', 5, 'b')).toBeNull();
    expect(toggleTaskLine('- [x] b\n', 0, 'b')).toBeNull();
  });

  it('保留 CRLF；只动 [ ] 不碰后面的方括号', () => {
    expect(toggleTaskLine('- [ ] 看 [文档]\r\n', 0, '看 [文档]')).toBe('- [x] 看 [文档]\r\n');
  });
});

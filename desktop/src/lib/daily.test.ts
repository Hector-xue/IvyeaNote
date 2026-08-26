import { describe, expect, it } from 'vitest';
import { todayPath, renderTemplate, dailyContent, templateFiles } from './daily';

describe('todayPath', () => {
  it('日记/YYYY-MM-DD.md', () => {
    expect(todayPath(new Date(2026, 7, 26))).toBe('日记/2026-08-26.md');
  });
});

describe('renderTemplate', () => {
  it('替换占位符', () => {
    const out = renderTemplate('# {{title}}\n{{date}} {{time}}', '会议', new Date(2026, 7, 26, 9, 5));
    expect(out).toBe('# 会议\n2026-08-26 09:05');
  });
});

describe('dailyContent', () => {
  it('含日期标题与待办区', () => {
    const c = dailyContent(new Date(2026, 7, 26));
    expect(c).toContain('# 2026-08-26');
    expect(c).toContain('- [ ]');
  });
});

describe('templateFiles', () => {
  it('只取 Templates/ 下的 md', () => {
    expect(
      templateFiles(['Templates/会议.md', 'Templates/x.png', '日记/a.md', 'Templates/子/周报.md'])
    ).toEqual(['Templates/会议.md', 'Templates/子/周报.md']);
  });
});

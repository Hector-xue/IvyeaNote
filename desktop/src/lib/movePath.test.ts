import { describe, expect, it } from 'vitest';
import { normalizeDir, planMove, remapPath } from './movePath';

const FILES = ['a.md', 'AI/agent.md', 'AI/llm.md', 'AI/子目录/x.md', '日记/2026-08-29.md'];

describe('planMove 文件', () => {
  it('根 → 文件夹', () => {
    expect(planMove('a.md', 'AI', FILES, false)).toEqual([{ from: 'a.md', to: 'AI/a.md' }]);
  });

  it('文件夹 → 根', () => {
    expect(planMove('AI/agent.md', '', FILES, false)).toEqual([
      { from: 'AI/agent.md', to: 'agent.md' },
    ]);
  });

  it('文件夹 → 另一个文件夹', () => {
    expect(planMove('AI/agent.md', '日记', FILES, false)).toEqual([
      { from: 'AI/agent.md', to: '日记/agent.md' },
    ]);
  });

  it('拖回原地 → null（不做无意义的搬迁）', () => {
    expect(planMove('AI/agent.md', 'AI', FILES, false)).toBeNull();
    expect(planMove('a.md', '', FILES, false)).toBeNull();
  });

  it('目标重名 → 自动序号，不覆盖已有笔记', () => {
    const files = [...FILES, 'AI/a.md'];
    expect(planMove('a.md', 'AI', files, false)).toEqual([{ from: 'a.md', to: 'AI/a-2.md' }]);
  });

  it('重名连撞两次 → -3', () => {
    const files = [...FILES, 'AI/a.md', 'AI/a-2.md'];
    expect(planMove('a.md', 'AI', files, false)).toEqual([{ from: 'a.md', to: 'AI/a-3.md' }]);
  });

  it('落点带多余斜杠也能归一化', () => {
    expect(planMove('a.md', '/AI/', FILES, false)).toEqual([{ from: 'a.md', to: 'AI/a.md' }]);
  });
});

describe('planMove 目录', () => {
  it('整体搬迁，内部结构保持', () => {
    const ops = planMove('AI', '日记', FILES, true);
    expect(ops).toEqual([
      { from: 'AI/agent.md', to: '日记/AI/agent.md' },
      { from: 'AI/llm.md', to: '日记/AI/llm.md' },
      { from: 'AI/子目录/x.md', to: '日记/AI/子目录/x.md' },
    ]);
  });

  it('目录搬到根', () => {
    const ops = planMove('AI/子目录', '', FILES, true);
    expect(ops).toEqual([{ from: 'AI/子目录/x.md', to: '子目录/x.md' }]);
  });

  it('拖进自己 → null', () => {
    expect(planMove('AI', 'AI', FILES, true)).toBeNull();
  });

  it('拖进自己的子目录 → null（否则会把目录搬进自身）', () => {
    expect(planMove('AI', 'AI/子目录', FILES, true)).toBeNull();
  });

  it('目标已有同名目录 → 自动序号', () => {
    const files = [...FILES, '日记/AI/old.md'];
    const ops = planMove('AI', '日记', files, true);
    expect(ops?.[0].to).toBe('日记/AI-2/agent.md');
  });

  it('空目录（只有 .keep）也能搬', () => {
    const files = ['空/.keep'];
    expect(planMove('空', 'AI', ['AI/agent.md', ...files], true)).toEqual([
      { from: '空/.keep', to: 'AI/空/.keep' },
    ]);
  });
});

describe('remapPath', () => {
  it('当前打开的文件被移动 → 跟着换路径', () => {
    const ops = [{ from: 'a.md', to: 'AI/a.md' }];
    expect(remapPath('a.md', ops)).toBe('AI/a.md');
  });

  it('没被移动的路径原样返回', () => {
    expect(remapPath('b.md', [{ from: 'a.md', to: 'AI/a.md' }])).toBe('b.md');
  });

  it('null 安全', () => {
    expect(remapPath(null, [])).toBeNull();
  });
});

describe('normalizeDir', () => {
  it('去掉首尾斜杠', () => {
    expect(normalizeDir('/AI/')).toBe('AI');
    expect(normalizeDir('')).toBe('');
    expect(normalizeDir('/')).toBe('');
  });
});

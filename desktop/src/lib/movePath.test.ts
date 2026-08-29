import { describe, expect, it } from 'vitest';
import { normalizeDir, planMove, remapPath, invertMoveOps } from './movePath';

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

// ---------------------------------------------------------------------------
// 回收站路径：生成与反解必须严格互逆，否则「删了能恢复」这条就断了

import { originalPathOf, trashPathFor } from '../hooks/useTrash';

describe('回收站路径', () => {
  const at = new Date('2026-08-29T11:22:33.000Z');

  it('生成：目录分隔符编码成 __，带时间戳前缀', () => {
    expect(trashPathFor('AI/agent.md', at)).toBe('.trash/2026-08-29T11-22-33-AI__agent.md');
  });

  it('反解：能还原出原始相对路径', () => {
    expect(originalPathOf('.trash/2026-08-29T11-22-33-AI__agent.md')).toBe('AI/agent.md');
  });

  it('生成 → 反解 严格互逆（含多层目录与中文名）', () => {
    for (const p of ['a.md', 'AI/agent.md', '日记/2026/08/29.md', '文章/引流 笔记.md']) {
      expect(originalPathOf(trashPathFor(p, at))).toBe(p);
    }
  });

  it('根目录文件反解后不带前导斜杠', () => {
    expect(originalPathOf(trashPathFor('a.md', at))).toBe('a.md');
  });
});

describe('invertMoveOps（撤销移动）', () => {
  it('首尾对调', () => {
    expect(invertMoveOps([{ from: 'a.md', to: '归档/a.md' }])).toEqual([
      { from: '归档/a.md', to: 'a.md' },
    ]);
  });

  it('顺序也倒过来——批次里可能有先后依赖，撤销必须后进先出', () => {
    const ops = [
      { from: '一.md', to: '归档/一.md' },
      { from: '二.md', to: '归档/二.md' },
    ];
    expect(invertMoveOps(ops).map((o) => o.from)).toEqual(['归档/二.md', '归档/一.md']);
  });

  it('反转两次回到原样', () => {
    const ops = [
      { from: '日记/一.md', to: '归档/日记/一.md' },
      { from: '日记/二.md', to: '归档/日记/二.md' },
    ];
    expect(invertMoveOps(invertMoveOps(ops))).toEqual(ops);
  });

  it('不改原数组', () => {
    const ops = [{ from: 'a.md', to: 'b/a.md' }];
    invertMoveOps(ops);
    expect(ops).toEqual([{ from: 'a.md', to: 'b/a.md' }]);
  });

  it('空批次返回空', () => {
    expect(invertMoveOps([])).toEqual([]);
  });
});

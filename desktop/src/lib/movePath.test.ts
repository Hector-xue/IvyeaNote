import { describe, expect, it } from 'vitest';
import {
  normalizeDir,
  planMove,
  remapPath,
  invertMoveOps,
  planRenameDir,
  remapDirKeys,
} from './movePath';

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

describe('planRenameDir（文件夹重命名）', () => {
  const paths = ['a.md', 'AI/agent.md', 'AI/子目录/x.md', '日记/一.md', '空/.keep'];

  it('整棵子树跟着换前缀', () => {
    const r = planRenameDir('AI', '人工智能', paths);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dir).toBe('人工智能');
    expect(r.ops).toEqual([
      { from: 'AI/agent.md', to: '人工智能/agent.md' },
      { from: 'AI/子目录/x.md', to: '人工智能/子目录/x.md' },
    ]);
  });

  it('子目录改名只动它自己那一段，父目录留在原处', () => {
    const r = planRenameDir('AI/子目录', '归档', paths);
    expect(r.ok && r.dir).toBe('AI/归档');
    expect(r.ok && r.ops).toEqual([{ from: 'AI/子目录/x.md', to: 'AI/归档/x.md' }]);
  });

  it('空文件夹（只有 .keep 占位）也能改名', () => {
    const r = planRenameDir('空', '不空了', paths);
    expect(r.ok && r.ops).toEqual([{ from: '空/.keep', to: '不空了/.keep' }]);
  });

  it('撞名不加序号，直接说重名——重命名是用户明确打进去的名字', () => {
    expect(planRenameDir('日记', 'AI', paths)).toEqual({ ok: false, reason: 'taken' });
  });

  it('名字没变 = same', () => {
    expect(planRenameDir('AI', 'AI', paths)).toEqual({ ok: false, reason: 'same' });
  });

  it('空名 / 纯空白 / 只有斜杠都是 invalid', () => {
    expect(planRenameDir('AI', '   ', paths)).toEqual({ ok: false, reason: 'invalid' });
    expect(planRenameDir('AI', '///', paths)).toEqual({ ok: false, reason: 'invalid' });
    expect(planRenameDir('', '新名', paths)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('名字里的斜杠被剥掉——那是移动，不是改名', () => {
    const r = planRenameDir('AI', '别的/AI', paths);
    expect(r.ok && r.dir).toBe('别的AI');
  });

  it('trim 之后与原名相同也算 same', () => {
    expect(planRenameDir('AI', ' AI ', paths)).toEqual({ ok: false, reason: 'same' });
  });
});

describe('remapDirKeys（折叠状态跟着改名走）', () => {
  it('自己和后代一起换前缀，别人不动', () => {
    expect(remapDirKeys(['AI', 'AI/子目录', '日记'], 'AI', '人工智能')).toEqual([
      '人工智能',
      '人工智能/子目录',
      '日记',
    ]);
  });

  it('前缀相同但不是子目录的（AI2）不受影响', () => {
    expect(remapDirKeys(['AI2'], 'AI', '人工智能')).toEqual(['AI2']);
  });
});

describe('HTML 工具的数据文件跟着搬（v0.11.24）', () => {
  it('移动 x.html 时 x.html.data.json 一起走；没有数据文件就只搬 HTML', () => {
    const all = ['工具/a.html', '工具/a.html.data.json', '工具/b.html', '归档/.keep'];
    expect(planMove('工具/a.html', '归档', all, false)).toEqual([
      { from: '工具/a.html', to: '归档/a.html' },
      { from: '工具/a.html.data.json', to: '归档/a.html.data.json' },
    ]);
    expect(planMove('工具/b.html', '归档', all, false)).toEqual([{ from: '工具/b.html', to: '归档/b.html' }]);
  });
});

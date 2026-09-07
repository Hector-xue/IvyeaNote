import { describe, expect, it } from 'vitest';
import { buildGraphData, nodeRadius, outgoingLinks, stepSimulation } from './graph';

const docs = [
  { path: 'a.md', content: '[[b]] [[c]]' },
  { path: 'b.md', content: '回链 [[a]]' },
  { path: 'c.md', content: '无链接' },
  { path: 'd.md', content: '指向未创建的 [[ghost]]' },
];

describe('buildGraphData', () => {
  it('全局图：节点含虚拟未创建节点', () => {
    const g = buildGraphData(docs);
    expect(g.nodes.map((n) => n.path).sort()).toEqual(['a.md', 'b.md', 'c.md', 'd.md', 'ghost.md']);
    // a→b, a→c, b→a, d→ghost
    expect(g.edges.length).toBe(4);
    expect(g.nodes.find((n) => n.path === 'ghost.md')!.virtual).toBe(true);
    expect(g.nodes.find((n) => n.path === 'a.md')!.virtual).toBe(false);
  });

  it('关掉「未创建的笔记」后虚拟节点与它的边一起消失', () => {
    const g = buildGraphData(docs, { includeVirtual: false });
    expect(g.nodes.some((n) => n.path === 'ghost.md')).toBe(false);
    expect(g.edges.some((e) => e.to === 'ghost.md')).toBe(false);
  });

  it('局部图：一跳只留邻居', () => {
    const g = buildGraphData(docs, { focusPath: 'a.md' });
    expect(g.nodes.map((n) => n.path).sort()).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('局部图：跳数放大后能捞到二跳', () => {
    const chain = [
      { path: 'x.md', content: '[[y]]' },
      { path: 'y.md', content: '[[z]]' },
      { path: 'z.md', content: '尽头' },
    ];
    expect(buildGraphData(chain, { focusPath: 'x.md', depth: 1 }).nodes.map((n) => n.path).sort()).toEqual([
      'x.md',
      'y.md',
    ]);
    expect(buildGraphData(chain, { focusPath: 'x.md', depth: 2 }).nodes.map((n) => n.path).sort()).toEqual([
      'x.md',
      'y.md',
      'z.md',
    ]);
  });

  /*
   * v0.11.0 的核心修复：旧实现只认 [[双链]]，普通 Markdown 链接一条边都不算。
   * 这条用例在旧代码上会失败（edges 为空）。
   */
  it('普通 Markdown 链接也算边，并按笔记自己的位置解析相对路径', () => {
    const md = [
      { path: '项目/甲.md', content: '见 [乙](./乙.md) 与 [根](../总览.md)' },
      { path: '项目/乙.md', content: '' },
      { path: '总览.md', content: '' },
    ];
    const g = buildGraphData(md);
    const pairs = g.edges.map((e) => `${e.from}->${e.to}`).sort();
    expect(pairs).toEqual(['项目/甲.md->总览.md', '项目/甲.md->项目/乙.md']);
  });

  it('外链、锚点与图片不算边', () => {
    const byTitle = new Map<string, string>();
    const out = outgoingLinks(
      {
        path: 'a.md',
        content: '[站](https://x.com) [锚](#标题) ![图](img/p.png) [真](b.md)',
      },
      byTitle
    );
    expect(out).toEqual(['b.md']);
  });

  it('自链不画', () => {
    const g = buildGraphData([{ path: 'a.md', content: '[[a]]' }]);
    expect(g.edges).toEqual([]);
  });
});

describe('stepSimulation', () => {
  it('重合的节点会被推开，且不会算出 NaN', () => {
    const g = buildGraphData(docs);
    for (const n of g.nodes) {
      n.x = 0;
      n.y = 0;
    }
    stepSimulation(g.nodes, g.edges);
    for (const n of g.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
    const spread = new Set(g.nodes.map((n) => `${n.x.toFixed(2)},${n.y.toFixed(2)}`));
    expect(spread.size).toBeGreaterThan(1);
  });

  it('被钉住的节点不动（拖拽时的行为）', () => {
    const g = buildGraphData(docs);
    const a = g.nodes.find((n) => n.path === 'a.md')!;
    const before = { x: a.x, y: a.y };
    stepSimulation(g.nodes, g.edges, {}, new Set(['a.md']));
    expect(a.x).toBe(before.x);
    expect(a.y).toBe(before.y);
  });

  it('反复推进后趋于收敛（总位移下降）', () => {
    const g = buildGraphData(docs);
    let first = 0;
    for (let i = 0; i < 5; i++) first = stepSimulation(g.nodes, g.edges, { alpha: 1 });
    let later = 0;
    for (let i = 0; i < 60; i++) later = stepSimulation(g.nodes, g.edges, { alpha: 0.1 });
    expect(later).toBeLessThan(first);
  });
});

describe('nodeRadius', () => {
  it('孤立节点也看得见，且随连接数增长但有上限', () => {
    expect(nodeRadius(0)).toBeGreaterThan(3);
    expect(nodeRadius(5)).toBeGreaterThan(nodeRadius(1));
    expect(nodeRadius(1000)).toBeLessThanOrEqual(13);
  });
});

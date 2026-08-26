import { describe, expect, it } from 'vitest';
import { buildGraph } from './graph';

const docs = [
  { path: 'a.md', content: '[[b]] [[c]]' },
  { path: 'b.md', content: '回链 [[a]]' },
  { path: 'c.md', content: '无链接' },
  { path: 'd.md', content: '指向未创建的 [[ghost]]' },
];

describe('buildGraph', () => {
  it('全局图：节点含虚拟未创建节点', () => {
    const g = buildGraph(docs);
    expect(g.nodes.map((n) => n.path).sort()).toEqual(['a.md', 'b.md', 'c.md', 'd.md', 'ghost.md']);
    expect(g.edges.length).toBe(4);
  });
  it('局部图：只保留一跳邻居', () => {
    const g = buildGraph(docs, 'a.md');
    const paths = g.nodes.map((n) => n.path).sort();
    expect(paths).toEqual(['a.md', 'b.md', 'c.md']);
    expect(g.edges.every((e) => ['a.md', 'b.md', 'c.md'].includes(e.from) && ['a.md', 'b.md', 'c.md'].includes(e.to))).toBe(true);
  });
  it('节点坐标落在画布内', () => {
    const g = buildGraph(docs);
    for (const n of g.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(30);
      expect(n.x).toBeLessThanOrEqual(570);
      expect(n.y).toBeGreaterThanOrEqual(30);
      expect(n.y).toBeLessThanOrEqual(490);
    }
  });
});

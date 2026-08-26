/**
 * v0.7.1 F8：图谱视图（纯 SVG 力导向，无第三方依赖）。
 * - 全局图谱：全部笔记为节点，[[链接]] 为边
 * - 局部图谱：当前笔记一跳邻居
 * - 简单力模拟（斥力+弹簧+中心引力）迭代后静态渲染；点击节点跳转
 */
import { extractLinks, titleOfPath } from './wikilink';

export interface GraphNode {
  path: string;
  title: string;
  x: number;
  y: number;
}

export interface GraphEdge {
  from: string; // path
  to: string; // path（目标不存在则为虚拟节点）
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** 由全部笔记构建图（focusPath 传入时只保留一跳邻居） */
export function buildGraph(
  docs: { path: string; content: string }[],
  focusPath?: string
): Graph {
  const titles = new Map(docs.map((d) => [d.path, titleOfPath(d.path)]));
  const edges: GraphEdge[] = [];
  const keep = new Set<string>();

  for (const d of docs) {
    for (const target of extractLinks(d.content)) {
      let to = docs.find((x) => titleOfPath(x.path) === target)?.path;
      if (!to) to = `${target}.md`; // 虚拟节点（未创建）
      edges.push({ from: d.path, to });
    }
  }

  if (focusPath) {
    keep.add(focusPath);
    for (const e of edges) {
      if (e.from === focusPath) keep.add(e.to);
      if (e.to === focusPath) keep.add(e.from);
    }
  } else {
    docs.forEach((d) => keep.add(d.path));
    edges.forEach((e) => keep.add(e.from));
    edges.forEach((e) => keep.add(e.to)); // 虚拟节点（未创建目标）
  }

  // 布局：圆形初始位置
  const nodes: GraphNode[] = [];
  let i = 0;
  for (const p of keep) {
    const angle = (i / Math.max(keep.size, 1)) * Math.PI * 2;
    nodes.push({
      path: p,
      title: titles.get(p) ?? titleOfPath(p),
      x: 300 + 200 * Math.cos(angle),
      y: 260 + 200 * Math.sin(angle),
    });
    i++;
  }
  const alive = nodes.filter((n) => docs.some((d) => d.path === n.path));
  const liveEdges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));

  // 力模拟（固定迭代）
  simulate(nodes, liveEdges);
  void alive;
  return { nodes, edges: liveEdges };
}

/** 简单力导向：150 轮斥力 + 弹簧 + 中心引力 */
function simulate(nodes: GraphNode[], edges: GraphEdge[]): void {
  const idx = new Map(nodes.map((n, i) => [n.path, i]));
  const W = 600;
  const H = 520;
  for (let iter = 0; iter < 150; iter++) {
    // 斥力
    for (let a = 0; a < nodes.length; a++) {
      for (let b = a + 1; b < nodes.length; b++) {
        const na = nodes[a];
        const nb = nodes[b];
        let dx = na.x - nb.x;
        let dy = na.y - nb.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          d2 = 1;
        }
        const f = 2000 / d2;
        const d = Math.sqrt(d2);
        na.x += (dx / d) * f;
        na.y += (dy / d) * f;
        nb.x -= (dx / d) * f;
        nb.y -= (dy / d) * f;
      }
    }
    // 弹簧
    for (const e of edges) {
      const ia = idx.get(e.from);
      const ib = idx.get(e.to);
      if (ia === undefined || ib === undefined) continue;
      const na = nodes[ia];
      const nb = nodes[ib];
      const dx = nb.x - na.x;
      const dy = nb.y - na.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - 120) * 0.02;
      na.x += (dx / d) * f;
      na.y += (dy / d) * f;
      nb.x -= (dx / d) * f;
      nb.y -= (dy / d) * f;
    }
    // 中心引力 + 边界
    for (const n of nodes) {
      n.x += (W / 2 - n.x) * 0.01;
      n.y += (H / 2 - n.y) * 0.01;
      n.x = Math.max(30, Math.min(W - 30, n.x));
      n.y = Math.max(30, Math.min(H - 30, n.y));
    }
  }
}

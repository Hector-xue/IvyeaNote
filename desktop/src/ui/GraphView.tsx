/**
 * v0.7.1 F8：图谱视图组件（SVG 渲染 buildGraph 结果）。
 * 全局/局部切换；点击节点打开笔记；虚拟节点（未创建）虚线显示。
 */
import { useMemo, useState } from 'react';
import { buildGraph, type GraphNode } from '../lib/graph';
import type { SearchDoc } from '../lib/searchIndex';

export interface GraphViewProps {
  docs: SearchDoc[];
  currentPath: string | null;
  onOpenNote(path: string): void;
  onClose(): void;
}

export function GraphView(props: GraphViewProps) {
  const [local, setLocal] = useState(!!props.currentPath);

  const graph = useMemo(
    () => buildGraph(props.docs, local && props.currentPath ? props.currentPath : undefined),
    [props.docs, local, props.currentPath]
  );

  const clickNode = (n: GraphNode) => {
    // 虚拟节点：让 App 走 onOpenNote（会因不存在而提示/由 wiki 逻辑创建——这里直接尝试打开）
    props.onOpenNote(n.path);
  };

  return (
    <div className="dlg-mask" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="graph-card">
        <div className="graph-head">
          <h2 className="dlg-title">{'\u56fe\u8c31'}</h2>
          <label className="graph-toggle">
            <input type="checkbox" checked={local} onChange={(e) => setLocal(e.target.checked)} />
            {'\u4ec5\u5f53\u524d\u7b14\u8bb0\u4e00\u8df3\u90bb\u5c45'}
          </label>
          <button className="btn primary" onClick={props.onClose}>
            {'\u5173\u95ed'}
          </button>
        </div>
        <svg viewBox="0 0 600 520" className="graph-svg">
          {graph.edges.map((e, i) => {
            const a = graph.nodes.find((n) => n.path === e.from);
            const b = graph.nodes.find((n) => n.path === e.to);
            if (!a || !b) return null;
            return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="graph-edge" />;
          })}
          {graph.nodes.map((n) => {
            const virtual = !props.docs.some((d) => d.path === n.path);
            const isCurrent = n.path === props.currentPath;
            return (
              <g
                key={n.path}
                className={`graph-node ${virtual ? 'virtual' : ''} ${isCurrent ? 'current' : ''}`}
                transform={`translate(${n.x},${n.y})`}
                onClick={() => clickNode(n)}
              >
                <circle r={isCurrent ? 10 : 7} />
                <text y={18} textAnchor="middle">
                  {n.title}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

/**
 * 图谱视图（v0.7.1 F8 起；v0.11.0 重做）。
 *
 * 旧版是一个 600×520 的固定弹窗：不能缩放、不能拖、不能搜，笔记一多就是一团黑点。
 * 现在是一张真正能用的图——
 * - **占满窗口**（图谱天生需要面积），Esc 关；
 * - **持续力模拟**：一帧一帧推进，收敛后自动停；数据变了重新加热；
 * - **缩放/平移**：滚轮缩放（以指针为锚）、空白处拖动平移、双击复位；
 * - **拖节点**：拖的时候它被钉住，邻居跟着重排；
 * - **搜索过滤 + 悬停聚焦**：命中/邻居保持不透明，其余淡出——
 *   这是「一团黑点」变得可读的关键，不是装饰；
 * - **局部图**可调跳数；「未创建的笔记」可关掉。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildGraphData,
  nodeRadius,
  stepSimulation,
  type GraphNode,
} from '../lib/graph';
import type { SearchDoc } from '../lib/searchIndex';
import { RibbonIcon } from './Icons';

export interface GraphViewProps {
  docs: SearchDoc[];
  currentPath: string | null;
  onOpenNote(path: string): void;
  onClose(): void;
}

interface Camera {
  x: number;
  y: number;
  k: number;
}

export function GraphView(props: GraphViewProps) {
  const [local, setLocal] = useState(!!props.currentPath);
  const [depth, setDepth] = useState(1);
  const [showVirtual, setShowVirtual] = useState(true);
  const [query, setQuery] = useState('');
  const [hover, setHover] = useState<string | null>(null);
  const [cam, setCam] = useState<Camera>({ x: 0, y: 0, k: 1 });
  const [, forceTick] = useState(0);

  const hostRef = useRef<HTMLDivElement>(null);
  const camRef = useRef(cam);
  camRef.current = cam;
  const pinned = useRef(new Set<string>());
  const dragNode = useRef<string | null>(null);
  const panFrom = useRef<{ x: number; y: number; cam: Camera } | null>(null);
  const alphaRef = useRef(1);
  const rafRef = useRef<number | null>(null);

  const graph = useMemo(
    () =>
      buildGraphData(props.docs, {
        focusPath: local && props.currentPath ? props.currentPath : undefined,
        depth,
        includeVirtual: showVirtual,
      }),
    [props.docs, local, props.currentPath, depth, showVirtual]
  );

  const nodeByPath = useMemo(() => {
    const m = new Map<string, GraphNode>();
    for (const n of graph.nodes) m.set(n.path, n);
    return m;
  }, [graph]);

  // ---- 力模拟循环：数据一变就重新加热，收敛后自己停 ----
  useEffect(() => {
    alphaRef.current = 1;
  }, [graph]);

  useEffect(() => {
    let stop = false;
    const tick = () => {
      if (stop) return;
      if (alphaRef.current > 0.005) {
        const moved = stepSimulation(graph.nodes, graph.edges, { alpha: alphaRef.current }, pinned.current);
        alphaRef.current *= 0.985;
        // 已经几乎不动了就直接熄火，别空转一整分钟只为了小数点后几位
        if (moved < graph.nodes.length * 0.05) alphaRef.current = 0;
        forceTick((v) => v + 1);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      stop = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [graph]);

  // ---- 首次进入：把整张图放进视野 ----
  const fitView = useCallback(() => {
    const host = hostRef.current;
    if (!host || graph.nodes.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of graph.nodes) {
      minX = Math.min(minX, n.x);
      maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y);
      maxY = Math.max(maxY, n.y);
    }
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const rect = host.getBoundingClientRect();
    /*
     * 上限 1.4：只有一两个节点时按包围盒去"填满窗口"，会把一个圆点放大成一个盘子。
     * 图谱的默认观感应该是"一张图"，不是"一个被放大的点"。
     */
    const k = Math.min(1.4, Math.max(0.1, Math.min((rect.width - 160) / w, (rect.height - 160) / h)));
    setCam({
      k,
      x: rect.width / 2 - ((minX + maxX) / 2) * k,
      y: rect.height / 2 - ((minY + maxY) / 2) * k,
    });
  }, [graph]);

  useEffect(() => {
    // 等模拟散开一点再取包围盒，否则会按"还挤在一起"的尺寸放到很大
    const t = window.setTimeout(fitView, 420);
    return () => window.clearTimeout(t);
  }, [fitView]);

  // ---- Esc 关闭 ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        props.onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  // ---- 滚轮缩放：以指针为锚，不是以画布中心 ----
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = host.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const c = camRef.current;
      const k = Math.min(4, Math.max(0.08, c.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      // 让指针底下那个点保持不动
      setCam({ k, x: px - ((px - c.x) / c.k) * k, y: py - ((py - c.y) / c.k) * k });
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, []);

  // ---- 拖动（节点 or 平移） ----
  const toWorld = (clientX: number, clientY: number) => {
    const rect = hostRef.current!.getBoundingClientRect();
    const c = camRef.current;
    return { x: (clientX - rect.left - c.x) / c.k, y: (clientY - rect.top - c.y) / c.k };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const path = (e.target as HTMLElement).closest<HTMLElement>('[data-node]')?.dataset.node;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (path) {
      dragNode.current = path;
      pinned.current.add(path);
      alphaRef.current = Math.max(alphaRef.current, 0.35);
    } else {
      panFrom.current = { x: e.clientX, y: e.clientY, cam: camRef.current };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (dragNode.current) {
      const n = nodeByPath.get(dragNode.current);
      if (n) {
        const w = toWorld(e.clientX, e.clientY);
        n.x = w.x;
        n.y = w.y;
        n.vx = 0;
        n.vy = 0;
        alphaRef.current = Math.max(alphaRef.current, 0.35);
      }
      return;
    }
    const p = panFrom.current;
    if (p) setCam({ ...p.cam, x: p.cam.x + (e.clientX - p.x), y: p.cam.y + (e.clientY - p.y) });
  };

  const endDrag = () => {
    if (dragNode.current) pinned.current.delete(dragNode.current);
    dragNode.current = null;
    panFrom.current = null;
  };

  // ---- 高亮集合：搜索命中 / 悬停节点及其邻居 ----
  const q = query.trim().toLowerCase();
  const focusSet = useMemo(() => {
    if (hover) return new Set([hover, ...(graph.adjacency.get(hover) ?? [])]);
    if (!q) return null;
    const hit = new Set<string>();
    for (const n of graph.nodes) if (n.title.toLowerCase().includes(q)) hit.add(n.path);
    return hit;
  }, [hover, q, graph]);

  const dim = (path: string) => (focusSet ? !focusSet.has(path) : false);
  /** 缩得太小时标签会糊成一片；只在够大或被聚焦时画 */
  const showLabel = (n: GraphNode) =>
    cam.k > 0.55 || n.path === props.currentPath || n.path === hover || (focusSet?.has(n.path) ?? false);

  return (
    <div className="graph-full" role="dialog" aria-modal="true" aria-label="图谱">
      <div className="graph-toolbar">
        <strong className="graph-title">图谱</strong>
        <span className="graph-count">
          {graph.nodes.length} 个节点 · {graph.edges.length} 条连接
        </span>
        <input
          className="graph-search"
          placeholder="筛选笔记标题…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="graph-chk">
          <input type="checkbox" checked={local} onChange={(e) => setLocal(e.target.checked)} />
          仅当前笔记
        </label>
        {local && (
          <label className="graph-chk">
            跳数
            <input
              type="range"
              min={1}
              max={4}
              value={depth}
              onChange={(e) => setDepth(Number(e.target.value))}
            />
            <span className="graph-depth">{depth}</span>
          </label>
        )}
        <label className="graph-chk">
          <input type="checkbox" checked={showVirtual} onChange={(e) => setShowVirtual(e.target.checked)} />
          未创建的笔记
        </label>
        <span className="graph-gap" />
        <button className="icon-btn" title="适应窗口" aria-label="适应窗口" onClick={fitView}>
          <RibbonIcon name="focus" size={16} />
        </button>
        <button className="icon-btn" title="关闭（Esc）" aria-label="关闭" onClick={props.onClose}>
          <RibbonIcon name="close" size={16} />
        </button>
      </div>

      <div
        className="graph-canvas"
        ref={hostRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={fitView}
      >
        {graph.nodes.length === 0 ? (
          <div className="graph-empty">
            这个库里还没有互相链接的笔记。
            <br />
            用 <code>[[笔记名]]</code> 或 <code>[文字](别的笔记.md)</code> 互相引用，图谱就长出来了。
          </div>
        ) : (
          <svg className="graph-svg">
            <g transform={`translate(${cam.x},${cam.y}) scale(${cam.k})`}>
              {graph.edges.map((e, i) => {
                const a = nodeByPath.get(e.from);
                const b = nodeByPath.get(e.to);
                if (!a || !b) return null;
                const faded = dim(e.from) && dim(e.to);
                return (
                  <line
                    key={i}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    className={`graph-edge ${faded ? 'dim' : ''}`}
                    strokeWidth={1 / Math.max(cam.k, 0.5)}
                  />
                );
              })}
              {graph.nodes.map((n) => {
                const r = nodeRadius(n.degree);
                const isCurrent = n.path === props.currentPath;
                return (
                  <g
                    key={n.path}
                    data-node={n.path}
                    className={`graph-node ${n.virtual ? 'virtual' : ''} ${isCurrent ? 'current' : ''} ${
                      dim(n.path) ? 'dim' : ''
                    }`}
                    transform={`translate(${n.x},${n.y})`}
                    onPointerEnter={() => setHover(n.path)}
                    onPointerLeave={() => setHover((h) => (h === n.path ? null : h))}
                    onClick={() => props.onOpenNote(n.path)}
                  >
                    <circle r={isCurrent ? r + 2 : r} />
                    {showLabel(n) && (
                      <text y={r + 11} textAnchor="middle" fontSize={11 / Math.max(cam.k, 0.6)}>
                        {n.title}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
        )}
        <div className="graph-hint">滚轮缩放 · 拖空白平移 · 拖节点重排 · 双击复位</div>
      </div>
    </div>
  );
}

/**
 * 应用内 PDF 阅读器（v0.11.0）。
 *
 * # 为什么要自己画
 *
 * 此前是 `<iframe src="blob:…">`，把渲染整个交给 WebView 自带的 PDF 阅读器。
 * 问题是**只有 Chromium 系桌面 WebView 才自带**：
 * - Linux 的 webkit2gtk 没有，一片空白；
 * - 安卓 WebView 没有，所以代码里专门有一条「交给系统应用打开」的分支——
 *   等于跳出应用；OPFS 库（没绑文件夹）连这条路都没有，点了什么都不发生；
 * - Windows 的 WebView2 有，但 blob: 源的 PDF 能不能进内置阅读器不由我们决定。
 *
 * 用户的原话是「PDF 文件也无法阅览」。所以这次把渲染收回自己手里：pdf.js 出
 * canvas，三端行为完全一致，和「笔记永远是本地文件」一样，看 PDF 也不该依赖运气。
 *
 * # 两个刻意的选择
 *
 * - **按需渲染**：只渲染进入视口的页（IntersectionObserver）。一本 300 页的书
 *   全渲染要几百 MB 显存，安卓上直接闪退。
 * - **不执行 PDF 里的脚本**：`enableScripting` 保持默认 false。pdf.js 出过
 *   「打开恶意 PDF 即执行任意脚本」的洞（GHSA-hq66-cqwq-w95j 影响 5.6.83–6.2.107），
 *   所以依赖直接钉在 6.3.x：`npm audit` 必须是 0 条。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { RibbonIcon } from './Icons';
import { raiseToast } from './Toast';

export interface PdfViewerProps {
  /** blob: URL */
  url: string;
  /** 库内路径，只用于标题栏与「用系统应用打开」 */
  path: string;
  onClose(): void;
  /** 绑定了磁盘文件夹时才有：交给系统 PDF 应用打开 */
  onOpenExternal?(): void;
}

type PdfDoc = {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy(): Promise<void>;
};
type PdfPage = {
  getViewport(o: { scale: number }): { width: number; height: number };
  render(o: { canvasContext: CanvasRenderingContext2D; viewport: unknown; canvas: HTMLCanvasElement }): {
    promise: Promise<void>;
    cancel(): void;
  };
};

const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3];

export function PdfViewer({ url, path, onClose, onOpenExternal }: PdfViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<PdfDoc | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  /** null = 适应宽度（默认）；数字 = 固定倍率 */
  const [zoom, setZoom] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** 已渲染过的页（按 `页码@倍率` 记，改倍率要重画） */
  const rendered = useRef(new Set<string>());
  const tasks = useRef(new Map<number, { cancel(): void }>());
  const [fitScale, setFitScale] = useState(1);

  // ---- 打开文档 ----
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    rendered.current.clear();
    void (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        // worker 由 Vite 作为资源发出；不设它 pdf.js 会去猜一个相对路径然后 404
        const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        // enableScripting 默认就是 false：PDF 里嵌的 JavaScript 一律不执行。
        // 我们只要看，不需要表单脚本，而这正是 pdf.js 历史漏洞的入口。
        const task = pdfjs.getDocument({ url });
        const doc = (await task.promise) as unknown as PdfDoc;
        if (cancelled) {
          void doc.destroy();
          return;
        }
        docRef.current = doc;
        setNumPages(doc.numPages);
        setPage(1);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      for (const t of tasks.current.values()) t.cancel();
      tasks.current.clear();
      const d = docRef.current;
      docRef.current = null;
      if (d) void d.destroy();
    };
  }, [url]);

  /** 适应宽度的倍率：容器宽度 / 第一页的原始宽度 */
  const recomputeFit = useCallback(async () => {
    const doc = docRef.current;
    const host = scrollRef.current;
    if (!doc || !host) return;
    try {
      const p = await doc.getPage(1);
      const base = p.getViewport({ scale: 1 });
      // 左右各留 24px，再减掉滚动条
      const avail = Math.max(240, host.clientWidth - 64);
      setFitScale(Math.min(3, Math.max(0.3, avail / base.width)));
    } catch {
      setFitScale(1);
    }
  }, []);

  useEffect(() => {
    if (numPages > 0) void recomputeFit();
  }, [numPages, recomputeFit]);

  useEffect(() => {
    const host = scrollRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (zoom === null) void recomputeFit();
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [zoom, recomputeFit]);

  const scale = zoom ?? fitScale;

  // 改倍率＝全部重画
  useEffect(() => {
    rendered.current.clear();
    for (const t of tasks.current.values()) t.cancel();
    tasks.current.clear();
  }, [scale]);

  /** 渲染一页到它自己的 canvas */
  const renderPage = useCallback(
    async (num: number) => {
      const doc = docRef.current;
      const host = scrollRef.current;
      if (!doc || !host) return;
      const key = `${num}@${scale.toFixed(3)}`;
      if (rendered.current.has(key)) return;
      rendered.current.add(key);
      const wrap = host.querySelector<HTMLElement>(`[data-pdf-page="${num}"]`);
      if (!wrap) return;
      try {
        const p = await doc.getPage(num);
        const vp = p.getViewport({ scale });
        // 高分屏：按 devicePixelRatio 放大位图，再用 CSS 缩回去，否则字是糊的
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const canvas = wrap.querySelector('canvas') ?? document.createElement('canvas');
        if (!canvas.parentElement) wrap.appendChild(canvas);
        canvas.width = Math.floor(vp.width * dpr);
        canvas.height = Math.floor(vp.height * dpr);
        canvas.style.width = `${Math.floor(vp.width)}px`;
        canvas.style.height = `${Math.floor(vp.height)}px`;
        wrap.style.width = `${Math.floor(vp.width)}px`;
        wrap.style.height = `${Math.floor(vp.height)}px`;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const task = p.render({ canvasContext: ctx, viewport: vp, canvas });
        tasks.current.set(num, task);
        await task.promise;
        tasks.current.delete(num);
      } catch (e) {
        // 取消是正常流程（翻太快 / 改倍率），不该弹给用户
        const msg = e instanceof Error ? e.message : String(e);
        if (!/cancel/i.test(msg)) {
          rendered.current.delete(key);
          raiseToast(`第 ${num} 页渲染失败：${msg}`, 'error');
        }
      }
    },
    [scale]
  );

  // ---- 按需渲染 + 当前页跟踪 ----
  useEffect(() => {
    const host = scrollRef.current;
    if (!host || numPages === 0) return;
    if (typeof IntersectionObserver === 'undefined') {
      // 没有 IO 的环境（老 WebView / jsdom）：老老实实全渲染
      for (let i = 1; i <= numPages; i++) void renderPage(i);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          const num = Number((en.target as HTMLElement).dataset.pdfPage);
          if (!num) continue;
          if (en.isIntersecting) {
            void renderPage(num);
            if (en.intersectionRatio > 0.5) setPage(num);
          }
        }
      },
      // rootMargin 提前一屏：翻页时不该看到空白再等它画
      { root: host, rootMargin: '600px 0px', threshold: [0, 0.5] }
    );
    host.querySelectorAll('[data-pdf-page]').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [numPages, renderPage]);

  const goto = (n: number) => {
    const host = scrollRef.current;
    const target = Math.max(1, Math.min(numPages, n));
    const el = host?.querySelector<HTMLElement>(`[data-pdf-page="${target}"]`);
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    setPage(target);
  };

  const stepZoom = (dir: 1 | -1) => {
    const cur = zoom ?? fitScale;
    const idx = ZOOMS.findIndex((z) => z > cur + 0.001);
    if (dir > 0) setZoom(ZOOMS[idx === -1 ? ZOOMS.length - 1 : idx]);
    else {
      const below = [...ZOOMS].reverse().find((z) => z < cur - 0.001);
      setZoom(below ?? ZOOMS[0]);
    }
  };

  // Ctrl+滚轮缩放（和所有阅读器一致）
  useEffect(() => {
    const host = scrollRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      stepZoom(e.deltaY < 0 ? 1 : -1);
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, fitScale]);

  return (
    <div className="pdf-view">
      <div className="pdf-bar">
        <span className="pdf-name" title={path}>
          {path.split('/').pop()}
        </span>
        <span className="pdf-gap" />
        <button className="icon-btn" title="上一页" aria-label="上一页" onClick={() => goto(page - 1)}>
          <RibbonIcon name="page-left" size={16} />
        </button>
        <span className="pdf-pageno">
          {numPages > 0 ? `${page} / ${numPages}` : '—'}
        </span>
        <button className="icon-btn" title="下一页" aria-label="下一页" onClick={() => goto(page + 1)}>
          <RibbonIcon name="page-right" size={16} />
        </button>
        <button className="icon-btn" title="缩小" aria-label="缩小" onClick={() => stepZoom(-1)}>
          <RibbonIcon name="zoom-out" size={16} />
        </button>
        <button
          className="pdf-zoom"
          title="点击恢复「适应宽度」"
          onClick={() => setZoom(null)}
        >
          {zoom === null ? '适应宽度' : `${Math.round(scale * 100)}%`}
        </button>
        <button className="icon-btn" title="放大" aria-label="放大" onClick={() => stepZoom(1)}>
          <RibbonIcon name="zoom-in" size={16} />
        </button>
        {onOpenExternal && (
          <button className="icon-btn" title="用系统应用打开" aria-label="用系统应用打开" onClick={onOpenExternal}>
            <RibbonIcon name="external-link" size={16} />
          </button>
        )}
        <button className="icon-btn" title="关闭预览" aria-label="关闭预览" onClick={onClose}>
          <RibbonIcon name="close" size={16} />
        </button>
      </div>
      <div className="pdf-scroll" ref={scrollRef}>
        {loading && <div className="pdf-msg">正在打开 PDF…</div>}
        {err && (
          <div className="pdf-msg pdf-err">
            打不开这个 PDF：{err}
            {onOpenExternal && (
              <>
                {' '}
                <button className="link" onClick={onOpenExternal}>
                  用系统应用打开
                </button>
              </>
            )}
          </div>
        )}
        {Array.from({ length: numPages }, (_, i) => (
          <div className="pdf-page" key={i + 1} data-pdf-page={i + 1} />
        ))}
      </div>
    </div>
  );
}

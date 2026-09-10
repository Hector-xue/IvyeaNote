/**
 * 应用内图片查看器（v0.11.22）。
 *
 * # 为什么不再用那张全屏蒙层
 *
 * 此前点开库里的图片是一层 `position:fixed` 的黑色蒙层（`.img-view`），点任意处
 * 关闭。用户的原话是「图片查看为什么不直接在侧边栏右侧的窗口自适应尺寸查看？
 * 就像 obsidian 这样」——Obsidian 打开一张图片，它就待在主区那一块，和笔记、PDF
 * 是同一种"当前在看什么"，侧栏还在、右栏还在、状态栏还在，随手就能点下一个文件。
 * 蒙层把整个应用盖住，看一眼就得先关掉才能干别的，多一步、也和主区那几种视图
 * （PDF / `.base` / HTML / 图谱）不是一个模型。
 *
 * 所以这一版把图片收进主区，工具条与 `ui/PdfViewer` 对齐：
 * - **默认适应窗口**：容器多大就摆多大，小图不放大（把 64px 的图标拉成一米宽
 *   既难看也没意义），大图整张收进来，不用滚；
 * - 缩放按钮 + `Ctrl+滚轮`，倍率与 PDF 用同一档位；
 * - 「用系统应用打开」留着——真要看细节、要编辑，交给专业工具。
 *
 * 手机端仍是那张全屏蒙层：小屏上主区就是全屏，蒙层反而是对的。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { RibbonIcon } from './Icons';

export interface ImageViewerProps {
  /** blob: URL（由 useAttachments.resolveImage 出） */
  url: string;
  /** 库内相对路径，只用于标题与「用系统应用打开」 */
  path: string;
  onClose(): void;
  /** 绑了磁盘文件夹时才有 */
  onOpenExternal?(): void;
}

const ZOOMS = [0.25, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4];

export function ImageViewer({ url, path, onClose, onOpenExternal }: ImageViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  /** 图片的原始像素尺寸；0 = 还没加载出来 */
  const [nat, setNat] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  /** null = 适应窗口（默认）；数字 = 固定倍率 */
  const [zoom, setZoom] = useState<number | null>(null);
  const [fit, setFit] = useState(1);
  const [err, setErr] = useState(false);

  // 换一张图 = 一切从头来：倍率、尺寸、错误状态都不能留着上一张的
  useEffect(() => {
    setNat({ w: 0, h: 0 });
    setZoom(null);
    setErr(false);
  }, [url]);

  /**
   * 适应窗口的倍率。
   * **上限是 1**：比窗口小的图就按原尺寸摆着，不拉伸——放大只会糊，
   * 而"这张图本来就这么小"是用户需要知道的事实。
   */
  const recomputeFit = useCallback(() => {
    const host = hostRef.current;
    if (!host || !nat.w || !nat.h) return;
    const availW = Math.max(80, host.clientWidth - 48);
    const availH = Math.max(80, host.clientHeight - 48);
    setFit(Math.min(1, availW / nat.w, availH / nat.h));
  }, [nat]);

  useEffect(() => recomputeFit(), [recomputeFit]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => recomputeFit());
    ro.observe(host);
    return () => ro.disconnect();
  }, [recomputeFit]);

  const scale = zoom ?? fit;

  const stepZoom = useCallback(
    (dir: 1 | -1) => {
      const cur = zoom ?? fit;
      if (dir > 0) {
        const up = ZOOMS.find((z) => z > cur + 0.001);
        setZoom(up ?? ZOOMS[ZOOMS.length - 1]);
      } else {
        const down = [...ZOOMS].reverse().find((z) => z < cur - 0.001);
        setZoom(down ?? ZOOMS[0]);
      }
    },
    [zoom, fit]
  );

  // Ctrl+滚轮缩放（和 PDF 阅读器、和所有看图工具一致）
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      stepZoom(e.deltaY < 0 ? 1 : -1);
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, [stepZoom]);

  const name = path.split('/').pop() ?? path;

  return (
    <div className="img-pane">
      <div className="pdf-bar">
        <span className="pdf-name" title={path}>
          {name}
        </span>
        <span className="pdf-gap" />
        {nat.w > 0 && (
          <span className="pdf-pageno" title="原始尺寸">
            {nat.w} × {nat.h}
          </span>
        )}
        <button className="icon-btn" title="缩小" aria-label="缩小" onClick={() => stepZoom(-1)}>
          <RibbonIcon name="zoom-out" size={16} />
        </button>
        <button className="pdf-zoom" title="点击恢复「适应窗口」" onClick={() => setZoom(null)}>
          {zoom === null ? '适应窗口' : `${Math.round(scale * 100)}%`}
        </button>
        <button className="icon-btn" title="放大" aria-label="放大" onClick={() => stepZoom(1)}>
          <RibbonIcon name="zoom-in" size={16} />
        </button>
        {onOpenExternal && (
          <button
            className="icon-btn"
            title="用系统应用打开"
            aria-label="用系统应用打开"
            onClick={onOpenExternal}
          >
            <RibbonIcon name="external-link" size={16} />
          </button>
        )}
        <button className="icon-btn" title="关闭" aria-label="关闭" onClick={onClose}>
          <RibbonIcon name="close" size={16} />
        </button>
      </div>
      <div className="img-scroll" ref={hostRef}>
        {err ? (
          <div className="pdf-msg pdf-err">
            这张图片打不开：{path}
            {onOpenExternal && (
              <>
                {' '}
                <button className="link" onClick={onOpenExternal}>
                  用系统应用打开
                </button>
              </>
            )}
          </div>
        ) : (
          <img
            className="img-canvas"
            src={url}
            alt={name}
            /*
             * 尺寸只在**知道原始尺寸之后**才写死。加载完成前留空，让它先按
             * CSS 的 max-width/max-height 摆着，不会闪一下再跳。
             */
            style={
              nat.w > 0
                ? {
                    width: `${Math.round(nat.w * scale)}px`,
                    height: 'auto',
                    // 写死尺寸时必须解掉 CSS 那两条上限，否则放大到超过容器时
                    // max-width 会把它按回去，"放大"点了没反应
                    maxWidth: 'none',
                    maxHeight: 'none',
                  }
                : undefined
            }
            onLoad={(e) => {
              const el = e.currentTarget;
              setNat({ w: el.naturalWidth, h: el.naturalHeight });
            }}
            onError={() => setErr(true)}
            /* 双击 = 在「适应窗口」和 100% 之间来回，看图工具的通用手势 */
            onDoubleClick={() => setZoom((z) => (z === null ? 1 : null))}
          />
        )}
      </div>
    </div>
  );
}

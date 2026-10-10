/**
 * v0.11.38：手机上光标不许被键盘 / 底部栏挡住。
 *
 * 用户原话：「我把光标放在了屏幕下半部准备修改内容，这时候键盘弹出，直接把要修改的地方
 * 给盖住了，即使输入内容也不会出现在眼前，还得自己去把内容往上滑动才会看见输入了什么。」
 *
 * 两件事叠在一起：
 * 1. **编辑器以为被盖住的那几行"看得见"。** 手机端滚的是 `.m-main`，它的盒子一直延伸到
 *    屏幕底；格式条 + 导航栏（`.m-bottom-wrap`）是 fixed 浮在它上面的。CodeMirror 的
 *    scrollIntoView 只拿滚动容器的边界比——光标落在浮层底下，它判定"已可见"，一像素都不滚。
 *    所以打字也不跟：每敲一个字它都"确认过光标在视野里"。
 *    解法是 `EditorView.scrollMargins`：把浮层（和键盘，若 WebView 没被顶起）盖住的那一截
 *    报成底部边距，CM 自己就会把光标停在它们上面。
 * 2. **键盘弹起本身不触发滚动。** 光标是点下去那一刻放的，键盘是之后才升起来的；
 *    CM 不会因为视口变矮去重新滚一次。这里监听视口变矮，编辑器有焦点就把光标滚回视野。
 *
 * 另外兜底一层：v0.11.37 的原生修复（MainActivity 把 WebView 顶上去）若在某台机器上没生效，
 * WebView 只缩视觉视口，布局视口还是全高，底部栏就压在键盘下面。`keyboardInset` 用
 * visualViewport 量出这一截，写进 CSS 变量 `--kb-inset`，底部栏和留白都跟着抬上去；
 * 原生修复生效时它恒为 0，什么都不变。
 */
import type { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type PluginValue } from '@codemirror/view';

/** 浮在编辑区底部、会挡住正文的元素（BottomBar 的外壳带这个属性） */
export const BOTTOM_OBSTACLE_ATTR = 'data-bottom-obstacle';

/** 光标与挡板之间再留一点空，别贴着格式条 */
const CUSHION = 12;

/**
 * 滚动容器底边以上、被挡住的高度。
 * `obstacleTops`：每个底部浮层的上沿；`visibleBottom`：视觉视口的下沿（键盘上沿）。
 * 全是 client 坐标。
 */
export function bottomObstruction(scrollerBottom: number, obstacleTops: number[], visibleBottom: number): number {
  const edge = Math.min(visibleBottom, ...obstacleTops);
  const hidden = scrollerBottom - edge;
  return hidden > 0 ? hidden + CUSHION : 0;
}

/**
 * 软键盘盖住布局视口的高度（WebView 没被顶起时才非 0）。
 * 双指放大时视觉视口也会变小，那不是键盘——scale ≠ 1 一律当 0。
 */
export function keyboardInset(win: Window = window): number {
  const vv = win.visualViewport;
  if (!vv || Math.abs(vv.scale - 1) > 0.01) return 0;
  const hidden = win.innerHeight - (vv.offsetTop + vv.height);
  // 地址栏 / 舍入抖动几像素不算键盘
  return hidden > 40 ? Math.round(hidden) : 0;
}

/** 与 CodeMirror scrollRectIntoView 同一判定：第一个真能滚的祖先；没有就是窗口 */
function scrollerBottom(view: EditorView): number {
  const win = view.dom.ownerDocument.defaultView ?? window;
  for (let el: HTMLElement | null = view.scrollDOM; el && el !== el.ownerDocument.body; el = el.parentElement) {
    if (el.scrollHeight > el.clientHeight) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === 'auto' || oy === 'scroll' || el === view.scrollDOM) {
        return el.getBoundingClientRect().top + el.clientHeight;
      }
    }
  }
  return win.visualViewport?.height ?? win.innerHeight;
}

function visibleBottom(win: Window): number {
  const vv = win.visualViewport;
  return vv ? vv.offsetTop + vv.height : win.innerHeight;
}

function obstacleTops(doc: Document): number[] {
  const out: number[] = [];
  doc.querySelectorAll<HTMLElement>(`[${BOTTOM_OBSTACLE_ATTR}]`).forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.height > 0) out.push(r.top);
  });
  return out;
}

const margins = () =>
  EditorView.scrollMargins.of((view) => {
  const win = view.dom.ownerDocument.defaultView ?? window;
  const bottom = bottomObstruction(scrollerBottom(view), obstacleTops(view.dom.ownerDocument), visibleBottom(win));
  return bottom > 0 ? { bottom } : null;
  });

/** 视口变矮（键盘升起 / 格式条出现）且编辑器有焦点 → 把光标滚回视野 */
const refollow = () =>
  ViewPlugin.fromClass(
  class implements PluginValue {
    private lastHeight: number;
    private timers: number[] = [];
    private readonly win: Window;
    constructor(private readonly view: EditorView) {
      this.win = view.dom.ownerDocument.defaultView ?? window;
      this.lastHeight = this.height();
      this.win.visualViewport?.addEventListener('resize', this.onResize);
      this.win.addEventListener('resize', this.onResize);
      view.contentDOM.addEventListener('focus', this.onFocus);
    }
    private height(): number {
      return this.win.visualViewport?.height ?? this.win.innerHeight;
    }
    private onResize = () => {
      const h = this.height();
      const shrank = h < this.lastHeight - 1;
      this.lastHeight = h;
      if (shrank) this.schedule();
    };
    /* 键盘动画期间 resize 可能只来一次（也可能一次都不来——原生把 WebView 顶起时
       有的机型只在动画结束才派发），焦点进来后再补两拍 */
    private onFocus = () => this.schedule();
    private schedule() {
      this.clear();
      for (const ms of [60, 320]) {
        this.timers.push(this.win.setTimeout(() => this.follow(), ms));
      }
    }
    private follow() {
      const view = this.view;
      if (!view.hasFocus) return;
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'nearest' }) });
    }
    private clear() {
      for (const t of this.timers) this.win.clearTimeout(t);
      this.timers = [];
    }
    destroy() {
      this.clear();
      this.win.visualViewport?.removeEventListener('resize', this.onResize);
      this.win.removeEventListener('resize', this.onResize);
      this.view.contentDOM.removeEventListener('focus', this.onFocus);
    }
  }
);

/**
 * 编辑器扩展：光标停在底部栏和键盘上面。
 * 懒创建、建一次复用：模块顶层直接 `.of()` / `fromClass()` 会让 mock 掉 @codemirror/view 的
 * 测试在 import 阶段就炸。
 */
let built: Extension[] | null = null;
export function caretAboveBars(): Extension[] {
  return (built ??= [margins(), refollow()]);
}

/**
 * 把 `keyboardInset` 同步到根元素的 `--kb-inset`。返回解绑函数。
 * 只在手机布局挂（MobileView）；桌面上不存在软键盘，挂了也恒为 0。
 */
export function trackKeyboardInset(win: Window = window): () => void {
  const root = win.document.documentElement;
  let last = -1;
  const update = () => {
    const v = keyboardInset(win);
    if (v === last) return;
    last = v;
    root.style.setProperty('--kb-inset', `${v}px`);
  };
  update();
  win.visualViewport?.addEventListener('resize', update);
  win.visualViewport?.addEventListener('scroll', update);
  win.addEventListener('resize', update);
  return () => {
    win.visualViewport?.removeEventListener('resize', update);
    win.visualViewport?.removeEventListener('scroll', update);
    win.removeEventListener('resize', update);
    root.style.removeProperty('--kb-inset');
  };
}

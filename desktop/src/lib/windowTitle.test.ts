// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { getWindowSubtitle, setWindowSubtitle, subscribeWindowSubtitle } from './windowTitle';
import { needsCustomChrome } from '../ui/WindowChrome';

/**
 * 自绘标题栏里两块能脱离 Tauri 单测的逻辑。
 * 真正的窗口行为只有 Windows 真机能验，但「什么时候该自绘」和「副标题怎么传」
 * 是纯判断，不该也留到真机才发现错。
 */
describe('needsCustomChrome', () => {
  it('不在 Tauri 里一律不自绘（浏览器 / 网页版没有我们该画的边框）', () => {
    expect(needsCustomChrome()).toBe(false);
  });

  it('只有 Tauri + Windows 才自绘', () => {
    const w = window as unknown as Record<string, unknown>;
    const ua = (v: string) =>
      Object.defineProperty(navigator, 'userAgent', { value: v, configurable: true });
    const original = navigator.userAgent;
    w.__TAURI_INTERNALS__ = {};
    try {
      ua('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
      expect(needsCustomChrome()).toBe(true);
      // macOS 保留原生红绿灯，Linux 各家合成器对透明窗支持不一，都不冒险
      ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
      expect(needsCustomChrome()).toBe(false);
      ua('Mozilla/5.0 (X11; Linux x86_64)');
      expect(needsCustomChrome()).toBe(false);
      // 安卓 WebView 的 UA 里也可能带 Windows 字样，必须先被移动端那条挡掉
      ua('Mozilla/5.0 (Linux; Android 14; Pixel) Windows');
      expect(needsCustomChrome()).toBe(false);
    } finally {
      ua(original);
      delete w.__TAURI_INTERNALS__;
    }
  });
});

describe('windowTitle store', () => {
  it('设置后取到新值', () => {
    setWindowSubtitle('文章/杂记.md');
    expect(getWindowSubtitle()).toBe('文章/杂记.md');
  });

  it('订阅者在变化时收到通知，设置相同值不再通知（否则每次渲染都会多一轮）', () => {
    setWindowSubtitle('a.md');
    let hits = 0;
    const off = subscribeWindowSubtitle(() => {
      hits += 1;
    });
    setWindowSubtitle('a.md');
    expect(hits).toBe(0);
    setWindowSubtitle('b.md');
    expect(hits).toBe(1);
    off();
    setWindowSubtitle('c.md');
    expect(hits).toBe(1); // 已退订
  });

  it('null / 空串归一成空串（App 传的是 currentPath ?? ""）', () => {
    setWindowSubtitle('x.md');
    setWindowSubtitle('');
    expect(getWindowSubtitle()).toBe('');
  });
});

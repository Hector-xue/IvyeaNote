// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { needsCustomChrome } from '../ui/WindowChrome';

/**
 * 「什么时候该自绘窗口边框」是纯判断，不该留到真机才发现错。
 * 真正的窗口行为（无边框拖拽/缩放/圆角）只有 Windows 真机能验。
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

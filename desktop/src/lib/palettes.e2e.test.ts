// @vitest-environment node
/**
 * 配色主题的守卫（v0.11.23）。
 *
 * 这三条都不是"为了有测试而写的测试"，每条对应一种**看着都对、其实坏了**的失败：
 *
 * ① 设置里的色块和真实界面用的不是一套色号——两边各自看着都正常，没人会发现；
 * ② 某套主题只写了浅色：用户切到深色，界面掉回默认绿，像是主题坏了；
 * ③ 配色好看但正文读不动——对比度这种东西靠肉眼看不出来，必须算。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PALETTES } from './palettes';

/*
 * ⚠️ **不能用 `import CSS from '...css?raw'`。**
 * vitest 默认 `css: false`，CSS 导入（含 `?raw`）一律被桩成空字符串——
 * 于是每个选择器都"找不到"，测试以一种毫不相干的方式红（实测拿到 len=0）。
 * 直接读文件最老实，代价是这条得待在 e2e 那一档（tsconfig.e2e 才有 node 类型）。
 */
const CSS = readFileSync(new URL('../styles/palettes.css', import.meta.url), 'utf-8');

/** 从 palettes.css 里抠出某个选择器块里的变量表 */
function block(selector: string): Record<string, string> {
  const i = CSS.indexOf(selector + ' {');
  if (i < 0) return {};
  const body = CSS.slice(i, CSS.indexOf('}', i));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const light = (key: string) => block(`:root[data-palette='${key}']`);
const dark = (key: string) => block(`:root[data-theme='dark'][data-palette='${key}']`);

/** WCAG 相对亮度 → 对比度 */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

describe('配色主题（对着 CSS 算色号与对比度）', () => {
  it('每套主题在 CSS 里**深浅两版都有**（只写浅色，切深色就掉回默认绿）', () => {
    for (const p of PALETTES) {
      expect(Object.keys(light(p.key)).length, `${p.label} 缺浅色`).toBeGreaterThan(5);
      expect(Object.keys(dark(p.key)).length, `${p.label} 缺深色`).toBeGreaterThan(5);
    }
  });

  it('设置里的色块 = CSS 里的真实色号（两边分叉了没人看得出来）', () => {
    for (const p of PALETTES) {
      const l = light(p.key);
      expect([l['--n-1'], l['--n-9'], l['--brand']].map((c) => c.toLowerCase())).toEqual(
        p.swatch.map((c) => c.toLowerCase())
      );
    }
  });

  /**
   * 次要文字的门槛为什么是 3.35 而不是 WCAG AA 的 4.5——
   *
   * 因为**默认主题「素纸」现在就是 3.39**（`--n-6: #8b8880` 在纸底上），
   * 整个产品的次要文字都在这一档。把门槛写成 4.5 就等于在"加几套主题"这件事里
   * 顺手把所有人的默认观感改掉，那是这个仓库明令禁止的（改默认必须先问）。
   *
   * 所以这里守的是**不比默认更差**：新主题一律 ≥ 默认那条线。
   * 真要整体提到 4.5 是另一件事，得单独提出来、单独改。
   */
  const MUTED_FLOOR = 3.35;

  it('正文 ≥ 7:1；次要文字不比默认主题更差；链接与按钮文字 ≥ 4.5:1（深浅两版都算）', () => {
    for (const p of PALETTES) {
      for (const [mode, t] of [
        ['浅色', light(p.key)],
        ['深色', dark(p.key)],
      ] as const) {
        const paper = t['--n-1'];
        expect(contrast(t['--n-9'], paper), `${p.label} ${mode} 正文`).toBeGreaterThanOrEqual(7);
        expect(contrast(t['--n-6'], paper), `${p.label} ${mode} 次要文字`).toBeGreaterThanOrEqual(MUTED_FLOOR);
        expect(contrast(t['--brand'], paper), `${p.label} ${mode} 链接/强调`).toBeGreaterThanOrEqual(4.5);
        // 强调色上面那行白字（按钮）也要读得清
        expect(contrast(t['--brand-ink'], t['--brand']), `${p.label} ${mode} 按钮文字`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('分隔线要看得见、又不能抢戏（1.05 ≤ 与纸的对比 ≤ 2）', () => {
    for (const p of PALETTES) {
      for (const [mode, t] of [
        ['浅色', light(p.key)],
        ['深色', dark(p.key)],
      ] as const) {
        const c = contrast(t['--n-3'], t['--n-1']);
        expect(c, `${p.label} ${mode} 分隔线`).toBeGreaterThan(1.05);
        expect(c, `${p.label} ${mode} 分隔线`).toBeLessThan(2);
      }
    }
  });


});

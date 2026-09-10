/**
 * 配色主题的纯逻辑守卫（v0.11.23）。
 *
 * 颜色本身对不对、深浅两版全不全，在 `palettes.e2e.test.ts` 里对着 CSS 文件算
 * （那条要读文件，按本仓库约定归 e2e 那一档，才有 node 类型）。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PALETTE, normalizePalette, paletteMeta } from './palettes';

describe('配色主题（纯逻辑）', () => {
  it('认不出的主题名回默认，绝不把未知值写进 DOM', () => {
    // 未知值写进 [data-palette] 会让所有主题规则都命不中，界面掉回裸默认值，
    // 用户看到的是"主题坏了"
    expect(normalizePalette('celadon')).toBe('celadon');
    expect(normalizePalette('不存在的主题')).toBe(DEFAULT_PALETTE);
    expect(normalizePalette(undefined)).toBe(DEFAULT_PALETTE);
    expect(normalizePalette(42)).toBe(DEFAULT_PALETTE);
  });

  it('paletteMeta 对任何输入都给得出一套（渲染时不会炸）', () => {
    expect(paletteMeta('soot').label).toBe('松烟');
    expect(paletteMeta('nope' as never).key).toBe(DEFAULT_PALETTE);
  });
});

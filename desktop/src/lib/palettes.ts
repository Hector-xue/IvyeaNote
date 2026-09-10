/**
 * 配色主题的注册表（v0.11.23）。
 *
 * **颜色本身在 `styles/palettes.css` 里，这儿只有元数据。**
 * 两处都写色号必然会分叉——设置里的色块显示的是一套颜色、界面用的是另一套，
 * 而且没人会发现，因为两边各自看着都对。这里的 `swatch` 是唯一的例外：
 * 设置里那三个小圆点要在**不切换主题**的前提下画出来，只能取值。
 * 它对应 palettes.css 里同名主题的 `--n-1 / --n-9 / --brand`，
 * `palettes.test.ts` 会把两边逐条对齐，改了一边另一边会红。
 */

export type PaletteKey = 'paper' | 'draft' | 'celadon' | 'moon' | 'soot';

export interface PaletteMeta {
  key: PaletteKey;
  label: string;
  /** 一句话说清它是什么感觉，别让人靠点开一个个试 */
  hint: string;
  /** 设置里的色块：[纸, 墨, 强调]，取自浅色那一套 */
  swatch: [string, string, string];
}

export const PALETTES: readonly PaletteMeta[] = [
  { key: 'paper', label: '素纸', hint: '暖白纸与松绿，默认', swatch: ['#fbfaf7', '#2b2a26', '#3f6b45'] },
  { key: 'draft', label: '稿纸', hint: '泛黄的米色，写长东西不刺眼', swatch: ['#faf5e9', '#2f2921', '#9a5b30'] },
  { key: 'celadon', label: '青瓷', hint: '冷灰青的釉面，安静', swatch: ['#f4f7f5', '#22302b', '#2f7a6b'] },
  { key: 'moon', label: '月白', hint: '接近无彩的冷蓝灰，最省眼', swatch: ['#f7f8fb', '#232838', '#3f5bb0'] },
  { key: 'soot', label: '松烟', hint: '带暖褐的墨色，深色最出彩', swatch: ['#f7f4ef', '#2a2620', '#6b5b4a'] },
] as const;

export const DEFAULT_PALETTE: PaletteKey = 'paper';

const KEYS = new Set<string>(PALETTES.map((p) => p.key));

/**
 * 收敛成合法主题名。
 *
 * 手改过的 localStorage、从新版降级回旧版、以后删掉某套主题——这三种情况下
 * 存着的名字都可能不认识。**认不出就回默认**，绝不把未知值写进 DOM：
 * 那会让 `[data-palette]` 一个规则都命中不了，界面掉回 tokens.css 的裸默认值，
 * 看着像"主题坏了"。
 */
export function normalizePalette(v: unknown): PaletteKey {
  return typeof v === 'string' && KEYS.has(v) ? (v as PaletteKey) : DEFAULT_PALETTE;
}

export function paletteMeta(key: PaletteKey): PaletteMeta {
  return PALETTES.find((p) => p.key === key) ?? PALETTES[0];
}

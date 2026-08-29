/**
 * 外观设置（v0.7.10 E10）。
 *
 * 只调**正文**的字号、宽度、字体，不缩放界面本身——这和 Obsidian 一致，
 * 也是对的：用户想调的是「读起来舒不舒服」，不是把侧栏按钮一起放大。
 *
 * 实现方式是覆盖 `styles/tokens.css` 里的 CSS 变量，不是另起一套样式。
 * 这正是把 token 抽成独立一层的回报：外观可调这件事几乎不用写新 CSS。
 *
 * ⚠️ 必须在 React 渲染之前应用（main.tsx 里调 `applyAppearance`），
 * 否则会先按默认值画一帧再跳成用户设置，那一下闪烁很廉价。
 */

export type ThemeMode = 'light' | 'dark' | 'system';
export type ReadFont = 'sans' | 'serif' | 'mono';

export interface Appearance {
  theme: ThemeMode;
  /** 正文字号 px */
  fontSize: number;
  /** 正文可读宽度 px；编辑态与阅读态共用 */
  measure: number;
  /** 正文行高倍数 */
  lineHeight: number;
  font: ReadFont;
}

export const DEFAULTS: Appearance = {
  theme: 'light',
  fontSize: 15,
  measure: 720,
  lineHeight: 1.75,
  font: 'sans',
};

/** 各项的合法区间。越界值一律夹回来，别让手改过的 localStorage 把界面搞坏 */
export const LIMITS = {
  fontSize: { min: 12, max: 24, step: 1 },
  measure: { min: 560, max: 1100, step: 20 },
  lineHeight: { min: 1.4, max: 2.2, step: 0.05 },
};

const KEY = 'ivnote.appearance';

const FONT_STACKS: Record<ReadFont, string> = {
  sans: 'var(--font-ui)',
  // 中文衬线优先思源宋体系；缺字时退回系统衬线，不要退到无衬线（那等于没切换）
  serif: "'Songti SC', 'Source Han Serif SC', 'Noto Serif CJK SC', 'SimSun', Georgia, serif",
  mono: 'var(--font-mono)',
};

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}

export function normalize(raw: Partial<Appearance> | null | undefined): Appearance {
  const a = { ...DEFAULTS, ...(raw ?? {}) };
  return {
    theme: a.theme === 'dark' || a.theme === 'system' ? a.theme : 'light',
    font: a.font === 'serif' || a.font === 'mono' ? a.font : 'sans',
    fontSize: clamp(Number(a.fontSize), LIMITS.fontSize.min, LIMITS.fontSize.max),
    measure: clamp(Number(a.measure), LIMITS.measure.min, LIMITS.measure.max),
    lineHeight: clamp(Number(a.lineHeight), LIMITS.lineHeight.min, LIMITS.lineHeight.max),
  };
}

export function loadAppearance(): Appearance {
  try {
    return normalize(JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Appearance>);
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveAppearance(a: Appearance): void {
  localStorage.setItem(KEY, JSON.stringify(a));
}

/** 主题模式 → 实际生效的深浅（system 时问系统） */
export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  return typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)')?.matches
    ? 'dark'
    : 'light';
}

/** 把设置写到 :root 上。幂等，可随时重复调用。 */
export function applyAppearance(a: Appearance = loadAppearance()): void {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(a.theme);
  root.style.setProperty('--fs-body', `${a.fontSize}px`);
  root.style.setProperty('--measure', `${a.measure}px`);
  root.style.setProperty('--lh-body', String(a.lineHeight));
  root.style.setProperty('--font-read', FONT_STACKS[a.font]);
}

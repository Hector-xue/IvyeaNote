import { describe, expect, it } from 'vitest';
import { DEFAULTS, normalize, resolveTheme } from './appearance';

describe('normalize：手改过的 localStorage 不能把界面搞坏', () => {
  it('缺字段补默认', () => {
    expect(normalize({ fontSize: 18 })).toEqual({ ...DEFAULTS, fontSize: 18 });
  });
  it('越界值夹回区间', () => {
    expect(normalize({ fontSize: 999 }).fontSize).toBe(24);
    expect(normalize({ fontSize: 1 }).fontSize).toBe(12);
    expect(normalize({ measure: 99999 }).measure).toBe(1100);
  });
  it('非数字退回下限而不是 NaN（NaN 写进 CSS 会让整条规则失效）', () => {
    expect(normalize({ fontSize: 'big' as unknown as number }).fontSize).toBe(12);
  });
  it('非法枚举值退回默认', () => {
    expect(normalize({ theme: 'neon' as unknown as 'light' }).theme).toBe('light');
    expect(normalize({ font: 'comic' as unknown as 'sans' }).font).toBe('sans');
    // v0.11.23：配色同理。认不出的名字写进 DOM 会让 [data-palette] 一条规则都命不中，
    // 界面掉回裸默认值，看着像"主题坏了"
    expect(normalize({ palette: 'neon' as never }).palette).toBe('paper');
  });

  it('老用户（存的 appearance 里没有 palette 这个字段）拿到默认配色，不是 undefined', () => {
    // 这条守的是升级路径：v0.11.22 存下来的对象里根本没有 palette
    expect(normalize({ theme: 'dark', fontSize: 17 }).palette).toBe('paper');
  });

  it('合法配色原样保留', () => {
    expect(normalize({ palette: 'soot' }).palette).toBe('soot');
  });
  it('null / undefined 直接给默认', () => {
    expect(normalize(null)).toEqual(DEFAULTS);
    expect(normalize(undefined)).toEqual(DEFAULTS);
  });
});

describe('resolveTheme', () => {
  it('显式深浅原样返回', () => {
    expect(resolveTheme('dark')).toBe('dark');
    expect(resolveTheme('light')).toBe('light');
  });
});

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

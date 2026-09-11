import { describe, it, expect } from 'vitest';
import { fmtWhen, fmtSize } from './when';

describe('fmtWhen', () => {
  const now = new Date(2026, 8, 11, 10, 51, 0).getTime();
  it('刚才 / 分钟前 / 今天 / 昨天 / 日期', () => {
    expect(fmtWhen(now - 10_000, now)).toBe('刚才');
    expect(fmtWhen(now - 5 * 60_000, now)).toBe('5 分钟前');
    expect(fmtWhen(new Date(2026, 8, 11, 8, 5).getTime(), now)).toBe('今天 08:05');
    expect(fmtWhen(new Date(2026, 8, 10, 23, 59).getTime(), now)).toBe('昨天 23:59');
    expect(fmtWhen(new Date(2026, 7, 1, 9, 0).getTime(), now)).toBe('8月1日 09:00');
    expect(fmtWhen(new Date(2025, 11, 31, 9, 0).getTime(), now)).toBe('2025年12月31日 09:00');
  });
  it('坏时间给空串而不是 NaN', () => {
    expect(fmtWhen(NaN, now)).toBe('');
  });
});

describe('fmtSize', () => {
  it('分档', () => {
    expect(fmtSize(12)).toBe('12 B');
    expect(fmtSize(2048)).toBe('2.0 KB');
    expect(fmtSize(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(fmtSize(undefined)).toBe('');
  });
});

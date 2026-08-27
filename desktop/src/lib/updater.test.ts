import { describe, expect, it } from 'vitest';
import { isNewer } from './updater';

describe('isNewer 语义化版本比较', () => {
  it('主/次/修订版本比较', () => {
    expect(isNewer('1.0.0', '0.9.9')).toBe(true);
    expect(isNewer('0.7.4', '0.7.3')).toBe(true);
    expect(isNewer('0.7.3', '0.7.4')).toBe(false);
  });
  it('相同版本返回 false', () => {
    expect(isNewer('0.7.3', '0.7.3')).toBe(false);
  });
  it('段数不足按 0 补齐比较', () => {
    expect(isNewer('0.8', '0.7.9')).toBe(true);
    expect(isNewer('0.7', '0.7.1')).toBe(false);
  });
  it('非数字段视为 0', () => {
    expect(isNewer('0.7.4-beta', '0.7.4')).toBe(false);
    expect(isNewer('0.8.0-beta', '0.7.4')).toBe(true);
  });
});

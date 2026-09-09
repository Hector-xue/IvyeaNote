import { describe, expect, it } from 'vitest';
import { diffLines } from './textDiff';

describe('按行 diff', () => {
  it('没改动时全是 same', () => {
    const rows = diffLines('甲\n乙', '甲\n乙');
    expect(rows.every((r) => r.kind === 'same')).toBe(true);
  });
  it('改一行 = 一删一加，其余不动', () => {
    const rows = diffLines('甲\n乙\n丙', '甲\n乙改\n丙');
    expect(rows.filter((r) => r.kind === 'del').map((r) => r.text)).toEqual(['乙']);
    expect(rows.filter((r) => r.kind === 'add').map((r) => r.text)).toEqual(['乙改']);
    expect(rows.filter((r) => r.kind === 'same').length).toBe(2);
  });
  it('纯新增不会把原文标成删除', () => {
    const rows = diffLines('甲', '甲\n乙');
    expect(rows.filter((r) => r.kind === 'del').length).toBe(0);
    expect(rows.filter((r) => r.kind === 'add').map((r) => r.text)).toEqual(['乙']);
  });
  it('超长文本退化成整段提示，不去跑 O(n·m)', () => {
    const long = Array.from({ length: 500 }, (_, i) => `行${i}`).join('\n');
    const rows = diffLines(long, long + '\n多一行');
    expect(rows.length).toBe(2);
    expect(rows[0].text).toContain('太长');
  });
});

/**
 * 自动选阅读密度。这层是"用规则替代大模型"的那部分，所以它必须**可复现**——
 * 同一篇文档任何时候都给同一个档位。测试盯的就是这件事，外加三条判据各自成立。
 */
import { describe, expect, it } from 'vitest';
import { measureDoc, pickDensity } from './density';

const NL = '\n';
const repeat = (line: string, n: number) => Array.from({ length: n }, () => line).join(NL);

describe('阅读密度', () => {
  it('代码/表格多 → 紧凑（等宽内容最怕折行）', () => {
    const src = ['# 技术笔记', '', '```ts', repeat('const a = compute(x, y);', 12), '```'].join(NL);
    const c = pickDensity(src);
    expect(c.tier).toBe('compact');
    expect(c.fontSize).toBeLessThan(15);
    expect(c.reason).toContain('代码');
  });

  it('短句 + 清单多 → 宽松（扫读型）', () => {
    const src = ['# 今日', '', repeat('- 待办一件事', 12)].join(NL);
    expect(pickDensity(src).tier).toBe('relaxed');
  });

  it('中文长段落 → 标准', () => {
    const src = repeat('这是一段足够长的中文段落，用来模拟真实的写作内容与排版需求。', 10);
    expect(pickDensity(src).tier).toBe('normal');
  });

  it('太短的文档不猜：一律标准', () => {
    expect(pickDensity('# 标题' + NL + NL + '一行字').tier).toBe('normal');
  });

  it('同一份内容两次结果完全一样（这正是不交给大模型的理由）', () => {
    const src = repeat('- 清单项', 20);
    expect(pickDensity(src)).toEqual(pickDensity(src));
  });

  it('度量本身：中文占比与代码占比算得对', () => {
    const m = measureDoc(['中文一行', '```', 'code', '```'].join(NL));
    expect(m.cjkRatio).toBeGreaterThan(0.5);
    expect(m.denseRatio).toBeGreaterThan(0.5);
  });
});

/**
 * 模糊匹配。
 *
 * 重点不是「能不能匹配上」，而是**排序对不对**——模糊匹配一旦把不相干的项排前面，
 * 用户宁可要原来的子串匹配。所以用例大多是「A 应该排在 B 前面」。
 */
import { describe, expect, it } from 'vitest';
import { fuzzyMatch, splitByRanges } from './fuzzy';

const score = (text: string, q: string) => fuzzyMatch(text, q)?.score ?? -Infinity;

describe('是否命中', () => {
  it('连续子串命中', () => {
    expect(fuzzyMatch('广告优化', '广告')).not.toBeNull();
  });

  it('不连续但按顺序也命中——这正是模糊匹配的意义', () => {
    expect(fuzzyMatch('亚马逊/广告优化', '亚广')).not.toBeNull();
    expect(fuzzyMatch('keyword-research', 'kwr')).not.toBeNull();
  });

  it('顺序不对不算命中', () => {
    expect(fuzzyMatch('广告优化', '化广')).toBeNull();
  });

  it('有字符不存在就不命中', () => {
    expect(fuzzyMatch('广告优化', '广告预算')).toBeNull();
  });

  it('大小写不敏感', () => {
    expect(fuzzyMatch('README', 'rme')).not.toBeNull();
  });

  it('空查询命中一切（面板初始状态要列出全部）', () => {
    expect(fuzzyMatch('任何东西', '')).toEqual({ score: 0, ranges: [] });
  });

  it('查询里的空格只作分隔，不参与匹配', () => {
    expect(fuzzyMatch('广告优化', '广 优')).not.toBeNull();
  });
});

describe('排序', () => {
  it('连续命中 > 分散命中', () => {
    expect(score('广告优化', '广告')).toBeGreaterThan(score('推广报告', '广告'));
  });

  it('命中在开头 > 命中在中间', () => {
    expect(score('广告优化', '广')).toBeGreaterThan(score('亚马逊广告', '广'));
  });

  it('命中在路径段首 > 命中在段中间', () => {
    expect(score('日记/广告复盘', '广')).toBeGreaterThan(score('日记/推广复盘', '广'));
  });

  it('同样是连续命中时，越短越靠前', () => {
    expect(score('广告优化', '广告')).toBeGreaterThan(score('这是一篇关于广告优化的长标题', '广告'));
  });

  it('跨度紧凑 > 跨度松散', () => {
    expect(score('广告优化', '广优')).toBeGreaterThan(score('广告投放策略与转化率优化', '广优'));
  });
});

describe('高亮区间', () => {
  it('连续命中合并成一个区间', () => {
    expect(fuzzyMatch('广告优化', '广告')?.ranges).toEqual([[0, 2]]);
  });

  it('分散命中给出多个区间', () => {
    expect(fuzzyMatch('广告优化', '广优')?.ranges).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it('splitByRanges 把文本切成命中/非命中交替段', () => {
    const r = fuzzyMatch('广告优化', '广优')!;
    expect(splitByRanges('广告优化', r.ranges)).toEqual([
      { text: '广', hit: true },
      { text: '告', hit: false },
      { text: '优', hit: true },
      { text: '化', hit: false },
    ]);
  });

  it('没有区间时原样返回一段', () => {
    expect(splitByRanges('广告优化', [])).toEqual([{ text: '广告优化', hit: false }]);
  });

  it('空文本不产生空段', () => {
    expect(splitByRanges('', [])).toEqual([]);
  });

  it('命中一直到结尾时不留空尾段', () => {
    const r = fuzzyMatch('广告', '广告')!;
    expect(splitByRanges('广告', r.ranges)).toEqual([{ text: '广告', hit: true }]);
  });
});

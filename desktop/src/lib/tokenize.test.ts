import { describe, expect, it } from 'vitest';
import { tokenize, tokenizeQuery } from './tokenize';

describe('tokenize', () => {
  it('CJK 切二元组', () => {
    expect(tokenize('多智能体')).toEqual(['多智', '智能', '能体']);
  });

  it('单字 CJK 段保留为单字（否则单字笔记搜不到）', () => {
    expect(tokenize('猫')).toEqual(['猫']);
    expect(tokenize('我 猫 你')).toEqual(['我', '猫', '你']);
  });

  it('拉丁按词切并小写', () => {
    expect(tokenize('Amazon ACoS')).toEqual(['amazon', 'acos']);
  });

  it('标点当分隔符，不进索引', () => {
    expect(tokenize('广告，优化')).toEqual(['广告', '优化']);
    expect(tokenize('a, b; c')).toEqual(['a', 'b', 'c']);
  });

  it('中英混排各按各的规则切', () => {
    // 「做广告优化」是一个连续 CJK 段，整段切二元组（含跨词的「做广」——
    // 这是二元组方案的固有代价，换来的是无需词典）
    expect(tokenize('用 GPT 做广告优化')).toEqual([
      '用',
      'gpt',
      '做广',
      '广告',
      '告优',
      '优化',
    ]);
  });

  it('数字与下划线算词的一部分', () => {
    expect(tokenize('gpt-4 run_id')).toEqual(['gpt', '4', 'run_id']);
  });

  it('空串与纯标点返回空', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('，。！ \n\t')).toEqual([]);
  });

  it('中日韩标点不当作 CJK 字（否则会和汉字连成假词）', () => {
    // 「广告」和「优化」被顿号隔开，不应产生跨标点的二元组
    expect(tokenize('广告、优化')).toEqual(['广告', '优化']);
  });
});

describe('tokenizeQuery', () => {
  it('多字词精确匹配，不走前缀', () => {
    expect(tokenizeQuery('广告')).toEqual([{ term: '广告', prefix: false }]);
  });

  it('单个 CJK 字标记为前缀匹配——索引里它只作为二元组的一半存在', () => {
    expect(tokenizeQuery('猫')).toEqual([{ term: '猫', prefix: true }]);
  });

  it('单个拉丁字母不走前缀（拉丁是整词索引）', () => {
    expect(tokenizeQuery('a')).toEqual([{ term: 'a', prefix: false }]);
  });

  it('与 tokenize 切法一致——不一致就会一个都命中不了', () => {
    const text = '亚马逊广告 ACoS 优化';
    expect(tokenizeQuery(text).map((t) => t.term)).toEqual(tokenize(text));
  });
});

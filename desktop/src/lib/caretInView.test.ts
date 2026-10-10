import { describe, expect, it } from 'vitest';
import { bottomObstruction, keyboardInset } from './caretInView';

function fakeWin(innerHeight: number, vv: { height: number; offsetTop?: number; scale?: number } | null): Window {
  return {
    innerHeight,
    visualViewport: vv ? { offsetTop: 0, scale: 1, ...vv } : null,
  } as unknown as Window;
}

describe('bottomObstruction：滚动容器底部被挡住多少', () => {
  it('底部栏浮在滚动区上面（手机端实测：.m-main 底 430、格式条+导航上沿 331）→ 挡住 99 + 留白', () => {
    expect(bottomObstruction(430, [331], 430)).toBe(99 + 12);
  });
  it('WebView 没被顶起：键盘上沿比底部栏还高 → 以键盘为准', () => {
    expect(bottomObstruction(780, [681], 430)).toBe(350 + 12);
  });
  it('桌面：滚动区底边在视口里、没有浮层 → 0（不改桌面行为）', () => {
    expect(bottomObstruction(700, [], 900)).toBe(0);
  });
});

describe('keyboardInset：键盘盖住布局视口的高度', () => {
  it('原生把 WebView 顶起（布局视口 = 视觉视口）→ 0', () => {
    expect(keyboardInset(fakeWin(430, { height: 430 }))).toBe(0);
  });
  it('只缩了视觉视口 → 量出键盘高度', () => {
    expect(keyboardInset(fakeWin(780, { height: 430 }))).toBe(350);
  });
  it('视觉视口被滚动过（offsetTop）也要扣掉', () => {
    expect(keyboardInset(fakeWin(780, { height: 430, offsetTop: 100 }))).toBe(250);
  });
  it('双指放大不是键盘 → 0', () => {
    expect(keyboardInset(fakeWin(780, { height: 390, scale: 2 }))).toBe(0);
  });
  it('几十像素的抖动（地址栏 / 舍入）不算键盘；没有 visualViewport → 0', () => {
    expect(keyboardInset(fakeWin(780, { height: 760 }))).toBe(0);
    expect(keyboardInset(fakeWin(780, null))).toBe(0);
  });
});

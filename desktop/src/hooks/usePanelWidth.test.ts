// @vitest-environment jsdom
/**
 * 面板调宽的行为锁定。
 *
 * 两个方向的符号最容易写反：侧栏在左，把手在它右边，**右拖变宽**；右栏在右，
 * 把手在它左边，**左拖才变宽**。写反了用户会觉得「面板在跟我对着干」。
 *
 * 另外盯住持久化时机：拖拽过程中不能写 localStorage（按住拖两秒会写几百次），
 * 松手才写。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { clampWidth, usePanelWidth } from './usePanelWidth';

beforeEach(() => localStorage.clear());

function setup(edge: 'left' | 'right', key = 'k') {
  return renderHook(() =>
    usePanelWidth({ key, defaultWidth: 264, min: 200, max: 520, edge, label: '侧栏' })
  );
}

/** 造一个带 setPointerCapture 的假事件 */
function pointerDown(clientX: number) {
  return {
    button: 0,
    clientX,
    pointerId: 1,
    preventDefault() {},
    currentTarget: { setPointerCapture() {} },
  } as unknown as React.PointerEvent<HTMLElement>;
}

function drag(from: number, to: number) {
  act(() => {
    window.dispatchEvent(
      Object.assign(new Event('pointermove'), { clientX: to, pointerId: 1 })
    );
  });
  void from;
}

function release() {
  act(() => {
    window.dispatchEvent(new Event('pointerup'));
  });
}

describe('clampWidth', () => {
  it('夹在上下限之间并取整', () => {
    expect(clampWidth(199.4, 200, 520)).toBe(200);
    expect(clampWidth(700, 200, 520)).toBe(520);
    expect(clampWidth(300.6, 200, 520)).toBe(301);
  });
});

describe('拖拽方向', () => {
  it('左侧面板（把手在右）：右拖变宽', () => {
    const { result } = setup('right');
    act(() => result.current.handleProps.onPointerDown(pointerDown(264)));
    drag(264, 324);
    expect(result.current.width).toBe(324);
  });

  it('左侧面板：左拖变窄', () => {
    const { result } = setup('right');
    act(() => result.current.handleProps.onPointerDown(pointerDown(264)));
    drag(264, 224);
    expect(result.current.width).toBe(224);
  });

  it('右侧面板（把手在左）：左拖才变宽——方向相反', () => {
    const { result } = setup('left');
    act(() => result.current.handleProps.onPointerDown(pointerDown(800)));
    drag(800, 740);
    expect(result.current.width).toBe(324);
  });

  it('拖过头会被上下限夹住', () => {
    const { result } = setup('right');
    act(() => result.current.handleProps.onPointerDown(pointerDown(264)));
    drag(264, 5000);
    expect(result.current.width).toBe(520);
    drag(264, -5000);
    expect(result.current.width).toBe(200);
  });
});

describe('持久化', () => {
  it('拖拽过程中不写，松手才写', () => {
    const { result } = setup('right', '宽度');
    act(() => result.current.handleProps.onPointerDown(pointerDown(264)));
    drag(264, 320);
    expect(localStorage.getItem('宽度')).toBeNull();
    release();
    expect(localStorage.getItem('宽度')).toBe('320');
  });

  it('下次挂载读回上次的宽度', () => {
    localStorage.setItem('宽度', '333');
    expect(setup('right', '宽度').result.current.width).toBe(333);
  });

  it('存量值超出上下限时夹回来（改过 min/max 之后不至于卡死）', () => {
    localStorage.setItem('宽度', '9999');
    expect(setup('right', '宽度').result.current.width).toBe(520);
  });

  it('存的是垃圾就回落到默认值', () => {
    localStorage.setItem('宽度', 'abc');
    expect(setup('right', '宽度').result.current.width).toBe(264);
  });
});

describe('键盘与双击', () => {
  it('左侧面板：→ 变宽、← 变窄，各 16px，且立刻落盘', () => {
    const { result } = setup('right', '宽度');
    act(() => result.current.handleProps.onKeyDown(key('ArrowRight')));
    expect(result.current.width).toBe(280);
    expect(localStorage.getItem('宽度')).toBe('280');
    act(() => result.current.handleProps.onKeyDown(key('ArrowLeft')));
    expect(result.current.width).toBe(264);
  });

  it('右侧面板的方向键同样是反的', () => {
    const { result } = setup('left');
    act(() => result.current.handleProps.onKeyDown(key('ArrowLeft')));
    expect(result.current.width).toBe(280);
  });

  it('Shift+方向键走大步', () => {
    const { result } = setup('right');
    act(() => result.current.handleProps.onKeyDown(key('ArrowRight', true)));
    expect(result.current.width).toBe(328);
  });

  it('Home/End 到上下限，Enter 复位到默认', () => {
    const { result } = setup('right');
    act(() => result.current.handleProps.onKeyDown(key('End')));
    expect(result.current.width).toBe(520);
    act(() => result.current.handleProps.onKeyDown(key('Home')));
    expect(result.current.width).toBe(200);
    act(() => result.current.handleProps.onKeyDown(key('Enter')));
    expect(result.current.width).toBe(264);
  });

  it('双击复位到默认宽度', () => {
    const { result } = setup('right');
    act(() => result.current.handleProps.onKeyDown(key('End')));
    act(() => result.current.handleProps.onDoubleClick());
    expect(result.current.width).toBe(264);
  });

  it('无关按键不动宽度', () => {
    const { result } = setup('right');
    act(() => result.current.handleProps.onKeyDown(key('a')));
    expect(result.current.width).toBe(264);
  });
});

describe('无障碍语义', () => {
  it('把手是 separator，带当前值与上下限', () => {
    const { result } = setup('right');
    const p = result.current.handleProps;
    expect(p.role).toBe('separator');
    expect(p['aria-orientation']).toBe('vertical');
    expect(p['aria-valuenow']).toBe(264);
    expect(p['aria-valuemin']).toBe(200);
    expect(p['aria-valuemax']).toBe(520);
    expect(p.tabIndex).toBe(0);
  });
});

function key(k: string, shift = false): React.KeyboardEvent<HTMLElement> {
  return { key: k, shiftKey: shift, preventDefault() {} } as unknown as React.KeyboardEvent<HTMLElement>;
}

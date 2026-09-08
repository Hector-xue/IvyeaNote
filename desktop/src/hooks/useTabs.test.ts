// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { nextActiveAfterClose, useTabs } from './useTabs';

beforeEach(() => localStorage.clear());

function setup() {
  const openFile = vi.fn(async () => undefined);
  const r = renderHook(() => useTabs({ openFile }));
  return { ...r, openFile };
}

/**
 * 关掉一个标签之后该激活谁。
 * 这条曾经在实现里被绕过（在 setState 回调里算、同一 tick 读），
 * 表现为"关掉当前标签就掉回空白页"——真实产物的点击验证抓到的。
 */
describe('nextActiveAfterClose', () => {
  const tabs = ['a.md', 'b.md', 'c.md'];

  it('关掉当前的 → 激活右边那个', () => {
    expect(nextActiveAfterClose(tabs, 'b.md', 'b.md')).toBe('c.md');
  });

  it('关掉最右边的当前标签 → 退回左边那个', () => {
    expect(nextActiveAfterClose(tabs, 'c.md', 'c.md')).toBe('b.md');
  });

  it('只剩一个，关掉就没有了', () => {
    expect(nextActiveAfterClose(['a.md'], 'a.md', 'a.md')).toBeNull();
  });

  it('关的不是当前那个 → 前台不动', () => {
    expect(nextActiveAfterClose(tabs, 'a.md', 'c.md')).toBe('c.md');
  });

  it('关一个根本不在列表里的 → 前台不动', () => {
    expect(nextActiveAfterClose(tabs, 'x.md', 'x.md')).toBe('x.md');
  });
});

/**
 * 下面这几条从 `useOpenNote.test.ts` 搬过来——多标签把那个 hook 取代了，
 * 但它守住的两件事一条都不能丢：**记住开着哪一篇**、**文件改了路径要跟上**。
 */
describe('打开与持久化', () => {
  it('打开会记住是哪一篇，并真的去读内容', async () => {
    const { result, openFile } = setup();
    await act(async () => {
      await result.current.open('a.md');
    });
    expect(result.current.activeNote).toBe('a.md');
    expect(result.current.tabs).toEqual(['a.md']);
    expect(openFile).toHaveBeenCalledWith('a.md');
  });

  it('标签与当前笔记写进 localStorage，重挂载后恢复', async () => {
    const { result, unmount } = setup();
    await act(async () => {
      await result.current.open('x/y.md');
    });
    await waitFor(() => expect(localStorage.getItem('ivnote.activeTab')).toBe('x/y.md'));
    unmount();
    const again = setup();
    expect(again.result.current.activeNote).toBe('x/y.md');
    expect(again.result.current.tabs).toEqual(['x/y.md']);
  });

  it('同一篇不会开出两个标签', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.open('a.md');
      await result.current.open('b.md');
      await result.current.open('a.md');
    });
    expect(result.current.tabs).toEqual(['a.md', 'b.md']);
    expect(result.current.activeNote).toBe('a.md');
  });

  it('关掉当前标签会落到相邻那一篇（不是掉回空白）', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.open('a.md');
      await result.current.open('b.md');
    });
    act(() => {
      result.current.close('b.md');
    });
    expect(result.current.tabs).toEqual(['a.md']);
    expect(result.current.activeNote).toBe('a.md');
  });

  it('库里没有的路径会被清掉（换库 / 外部删除）', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.open('a.md');
      await result.current.open('b.md');
    });
    act(() => result.current.prune(['a.md']));
    expect(result.current.tabs).toEqual(['a.md']);
    expect(result.current.activeNote).toBeNull();
  });
});

describe('路径重映射', () => {
  it('移动/重命名后指向新路径（否则记着的是一个不存在的文件）', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.open('a.md');
    });
    act(() => result.current.remap([{ from: 'a.md', to: 'sub/a.md' }]));
    expect(result.current.activeNote).toBe('sub/a.md');
    expect(result.current.tabs).toEqual(['sub/a.md']);
  });

  it('改的不是当前这篇 → 当前不动', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.open('a.md');
    });
    act(() => result.current.remap([{ from: 'b.md', to: 'sub/b.md' }]));
    expect(result.current.activeNote).toBe('a.md');
  });

  it('目录整体搬迁：多条一次性重映射', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.open('old/b.md');
    });
    act(() =>
      result.current.remap([
        { from: 'old/a.md', to: 'new/a.md' },
        { from: 'old/b.md', to: 'new/b.md' },
      ])
    );
    expect(result.current.activeNote).toBe('new/b.md');
  });

  it('空数组是安全的 no-op', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.open('a.md');
    });
    act(() => result.current.remap([]));
    expect(result.current.activeNote).toBe('a.md');
  });
});

// @vitest-environment jsdom
/**
 * 当前笔记（前身 useTabs）。多标签页在 v0.10.7 随顶部标签栏一起删掉了，
 * 留下的两件事仍然要有护栏：**记住开着哪一篇**、**文件改了路径要跟上**。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useOpenNote } from './useOpenNote';

beforeEach(() => localStorage.clear());

function setup() {
  const openFile = vi.fn(async () => undefined);
  const r = renderHook(() => useOpenNote({ openFile }));
  return { ...r, openFile };
}

describe('打开笔记', () => {
  it('打开会记住是哪一篇，并真的去读内容', async () => {
    const { result, openFile } = setup();
    await act(async () => {
      await result.current.open('a.md');
    });
    expect(result.current.activeNote).toBe('a.md');
    expect(openFile).toHaveBeenCalledWith('a.md');
  });

  it('当前笔记写进 localStorage，重挂载后恢复', async () => {
    const { result, unmount } = setup();
    await act(async () => {
      await result.current.open('x/y.md');
    });
    await waitFor(() => expect(localStorage.getItem('ivnote.activeTab')).toBe('x/y.md'));
    unmount();
    const again = setup();
    expect(again.result.current.activeNote).toBe('x/y.md');
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

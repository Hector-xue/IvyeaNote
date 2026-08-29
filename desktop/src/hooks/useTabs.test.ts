// @vitest-environment jsdom
/**
 * useTabs 的行为锁定。
 *
 * 重点是 `remap`：文件被移动或重命名后，标签里存的还是旧路径——点上去就是一个
 * 已经不存在的文件。v0.7.7 之前只有拖拽移动那条路径记得处理，重命名那条忘了。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTabs } from './useTabs';

const opened: string[] = [];
const onEmpty = vi.fn();
const openFile = vi.fn(async (p: string) => {
  opened.push(p);
});

beforeEach(() => {
  localStorage.clear();
  opened.length = 0;
  onEmpty.mockClear();
  openFile.mockClear();
});
afterEach(() => {
  localStorage.clear();
});

function setup() {
  return renderHook(() => useTabs({ openFile, onEmpty }));
}

describe('打开与关闭', () => {
  it('打开笔记会建标签并激活', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.openInTab('a.md');
    });
    expect(result.current.openTabs).toEqual(['a.md']);
    expect(result.current.activeTab).toBe('a.md');
    expect(opened).toEqual(['a.md']);
  });

  it('重复打开同一篇不会建重复标签', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.openInTab('a.md');
    });
    await act(async () => {
      await result.current.openInTab('a.md');
    });
    expect(result.current.openTabs).toEqual(['a.md']);
  });

  it('关掉当前标签 → 切到相邻的那个', async () => {
    const { result } = setup();
    for (const p of ['a.md', 'b.md', 'c.md']) {
      await act(async () => {
        await result.current.openInTab(p);
      });
    }
    act(() => result.current.closeTab('c.md'));
    expect(result.current.openTabs).toEqual(['a.md', 'b.md']);
    expect(result.current.activeTab).toBe('b.md');
  });

  it('关掉非当前标签 → 当前标签不动', async () => {
    const { result } = setup();
    for (const p of ['a.md', 'b.md']) {
      await act(async () => {
        await result.current.openInTab(p);
      });
    }
    act(() => result.current.closeTab('a.md'));
    expect(result.current.activeTab).toBe('b.md');
  });

  it('关掉最后一个标签 → 通知上层清空编辑区', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.openInTab('a.md');
    });
    act(() => result.current.closeTab('a.md'));
    expect(result.current.openTabs).toEqual([]);
    expect(result.current.activeTab).toBeNull();
    expect(onEmpty).toHaveBeenCalled();
  });
});

describe('remap：路径变了标签必须跟着变', () => {
  it('移动后标签指向新路径（否则点上去是不存在的文件）', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.openInTab('a.md');
    });
    act(() => result.current.remap([{ from: 'a.md', to: 'AI/a.md' }]));
    expect(result.current.openTabs).toEqual(['AI/a.md']);
    expect(result.current.activeTab).toBe('AI/a.md');
  });

  it('只改受影响的标签，其余不动', async () => {
    const { result } = setup();
    for (const p of ['a.md', 'b.md']) {
      await act(async () => {
        await result.current.openInTab(p);
      });
    }
    act(() => result.current.remap([{ from: 'a.md', to: 'AI/a.md' }]));
    expect(result.current.openTabs).toEqual(['AI/a.md', 'b.md']);
    expect(result.current.activeTab).toBe('b.md'); // 当前是 b，不该被动到
  });

  it('目录整体搬迁：多条一次性重映射', async () => {
    const { result } = setup();
    for (const p of ['AI/x.md', 'AI/y.md']) {
      await act(async () => {
        await result.current.openInTab(p);
      });
    }
    act(() =>
      result.current.remap([
        { from: 'AI/x.md', to: '归档/AI/x.md' },
        { from: 'AI/y.md', to: '归档/AI/y.md' },
      ])
    );
    expect(result.current.openTabs).toEqual(['归档/AI/x.md', '归档/AI/y.md']);
  });

  it('空数组是安全的 no-op', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.openInTab('a.md');
    });
    act(() => result.current.remap([]));
    expect(result.current.openTabs).toEqual(['a.md']);
  });
});

describe('持久化', () => {
  it('标签与激活项写进 localStorage，重挂载后恢复', async () => {
    const first = setup();
    await act(async () => {
      await first.result.current.openInTab('a.md');
    });
    first.unmount();

    const second = setup();
    expect(second.result.current.openTabs).toEqual(['a.md']);
    expect(second.result.current.activeTab).toBe('a.md');
  });

  it('localStorage 里是坏数据也不能崩（手改过/版本不兼容）', () => {
    localStorage.setItem('ivnote.tabs', '{不是数组}');
    const { result } = setup();
    expect(result.current.openTabs).toEqual([]);
  });
});

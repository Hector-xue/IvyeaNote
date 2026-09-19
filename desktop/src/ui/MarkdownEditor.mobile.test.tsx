// @vitest-environment jsdom
/**
 * v0.11.35：手机端长按 / 选区工具的数据流。
 *
 * 用户原话：「长按复制无法滑动选中文字，会一下子选中所有文字，要么选中长按弹窗的文字」。
 * 根因是编辑区的 contextmenu 处理无条件 preventDefault——安卓 WebView 的长按先选词再派发
 * contextmenu，被取消后选词、把手、系统复制条一并没了，只剩我们那张桌面菜单。
 * 这里验证：手指来的 contextmenu 放行、鼠标来的照旧弹菜单（阳性对照）、
 * 选区非空时把复制 / 剪切 / 更多交给底部栏、「更多」弹的是底部一张纸而不是桌面菜单。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { MarkdownEditor, contextMenuFromTouch, type SelectionTools } from './MarkdownEditor';

if (!window.matchMedia) {
  window.matchMedia = (() => ({
    matches: false,
    media: '',
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// jsdom 没有布局：CodeMirror 的 posAtCoords 会去量 Range，给它一个空的
if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
}

afterEach(() => cleanup());

/** 造一个 contextmenu 事件；`pointerType` 是 Chromium 106+ 才有的字段，jsdom 没有 PointerEvent，手工贴上去 */
function contextMenuEvent(pointerType?: string) {
  const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  if (pointerType !== undefined) Object.defineProperty(ev, 'pointerType', { value: pointerType });
  return ev;
}

function view(): EditorView {
  const v = EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!);
  if (!v) throw new Error('没找到 CodeMirror 实例');
  return v;
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

describe('contextMenuFromTouch', () => {
  it('pointerType 说了算：touch 是手指，mouse / pen 不是', () => {
    expect(contextMenuFromTouch(contextMenuEvent('touch'))).toBe(true);
    expect(contextMenuFromTouch(contextMenuEvent('mouse'))).toBe(false);
    expect(contextMenuFromTouch(contextMenuEvent('pen'))).toBe(false);
  });
  it('老 WebView 没有 pointerType：按设备主指针判（本环境是 fine → 不是手指）', () => {
    expect(contextMenuFromTouch(contextMenuEvent())).toBe(false);
  });
});

describe('MarkdownEditor 手机端长按', () => {
  const renderEditor = (extra: Partial<React.ComponentProps<typeof MarkdownEditor>> = {}) =>
    render(
      <MarkdownEditor
        mobile
        doc={'hello world\n\n[站点](https://example.com)'}
        onEdit={() => undefined}
        currentPath="a.md"
        theme="light"
        mode="edit"
        onModeChange={() => undefined}
        {...extra}
      />
    );

  it('手指长按正文：不 preventDefault、不弹任何菜单（把选词 / 把手 / 系统复制条留给系统）', async () => {
    renderEditor();
    await waitFor(() => expect(document.querySelector('.cm-content')).toBeTruthy());
    const ev = contextMenuEvent('touch');
    document.querySelector('.cm-content')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(document.querySelector('.ctx-menu')).toBeNull();
    expect(document.querySelector('.m-sheet2')).toBeNull();
  });

  it('鼠标右键（阳性对照）：照旧接管并弹菜单——手机上是底部一张纸而不是桌面菜单', async () => {
    renderEditor();
    await waitFor(() => expect(document.querySelector('.cm-content')).toBeTruthy());
    const ev = contextMenuEvent('mouse');
    document.querySelector('.cm-content')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await waitFor(() => expect(document.querySelector('.m-sheet2')).toBeTruthy());
    expect(document.querySelector('.ctx-menu')).toBeNull();
    const labels = [...document.querySelectorAll('.m-sheet2-item')].map((b) => b.textContent);
    expect(labels).toContain('复制');
    expect(labels).toContain('粘贴');
  });

  it('手指长按阅读态的链接：由我们接管，纸上第一组是「打开链接 / 复制链接地址」', async () => {
    renderEditor({ mode: 'read' });
    await waitFor(() => expect(document.querySelector('.md-preview a')).toBeTruthy());
    const ev = contextMenuEvent('touch');
    document.querySelector('.md-preview a')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await waitFor(() => expect(document.querySelector('.m-sheet2')).toBeTruthy());
    const labels = [...document.querySelectorAll('.m-sheet2-item')].map((b) => b.textContent);
    expect(labels.slice(0, 2)).toEqual(['打开链接', '复制链接地址']);
  });
});

describe('MarkdownEditor 手机端选区工具桥', () => {
  let tools: SelectionTools | null | undefined;
  const expose = vi.fn((t: SelectionTools | null) => {
    tools = t;
  });
  const writeText = vi.fn(async () => undefined);
  beforeEach(() => {
    tools = undefined;
    expose.mockClear();
    writeText.mockClear();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });

  const setup = async () => {
    render(
      <MarkdownEditor
        mobile
        doc={'hello world'}
        onEdit={() => undefined}
        currentPath="a.md"
        theme="light"
        mode="edit"
        onModeChange={() => undefined}
        exposeSelectionTools={expose}
      />
    );
    await waitFor(() => expect(document.querySelector('.cm-content')).toBeTruthy());
    // 编辑态一上来就有工具（「更多」不要求选区），只是 hasSelection 为 false
    expect(tools).toMatchObject({ hasSelection: false });
  };

  const select = async (anchor: number, head: number) => {
    await act(async () => {
      view().dispatch({ selection: { anchor, head } });
      document.dispatchEvent(new Event('selectionchange'));
      await nextFrame();
    });
  };

  it('选区非空 → hasSelection=true、copy 复制的是选中的字；折叠 → hasSelection=false', async () => {
    await setup();
    await select(0, 5);
    expect(tools?.hasSelection).toBe(true);
    tools!.copy();
    expect(writeText).toHaveBeenCalledWith('hello');
    await select(3, 3);
    expect(tools?.hasSelection).toBe(false);
    tools!.copy();
    expect(writeText).toHaveBeenCalledTimes(1); // 没选区时 copy 什么也不做
  });

  it('阅读态 / 只读预览：回传 null（底部栏一个都不画）', async () => {
    render(
      <MarkdownEditor
        mobile
        doc={'hello world'}
        onEdit={() => undefined}
        currentPath="a.md"
        theme="light"
        mode="read"
        onModeChange={() => undefined}
        exposeSelectionTools={expose}
      />
    );
    await waitFor(() => expect(expose).toHaveBeenCalled());
    expect(tools).toBeNull();
  });

  it('cut：写进剪贴板成功后才删文字，删完 hasSelection 立刻收掉', async () => {
    await setup();
    await select(0, 6);
    tools!.cut();
    await waitFor(() => expect(view().state.doc.toString()).toBe('world'));
    expect(writeText).toHaveBeenCalledWith('hello ');
    await waitFor(() => expect(tools?.hasSelection).toBe(false));
  });

  it('cut：剪贴板写失败就不删字（否则等于把内容丢了）', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    await setup();
    await select(0, 6);
    tools!.cut();
    await new Promise((r) => setTimeout(r, 30));
    expect(view().state.doc.toString()).toBe('hello world');
  });

  it('more：没有选区也能开（插入表格 / 段落设置不需要选中什么），此时 复制 / 剪切 置灰', async () => {
    await setup();
    act(() => tools!.more());
    await waitFor(() => expect(document.querySelector('.m-sheet2')).toBeTruthy());
    const item = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('.m-sheet2-item')].find((b) => b.textContent === label);
    expect(item('复制')?.disabled).toBe(true);
    expect(item('插入')).toBeTruthy();
  });

  it('more：弹底部一张纸，带二级菜单的项点下去进下一层', async () => {
    await setup();
    await select(0, 5);
    act(() => tools!.more());
    await waitFor(() => expect(document.querySelector('.m-sheet2')).toBeTruthy());
    expect(document.querySelector('.ctx-menu')).toBeNull();
    const item = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('.m-sheet2-item')].find((b) => b.textContent === label);
    expect(item('复制')?.disabled).toBe(false);
    expect(item('文本格式')).toBeTruthy();
    fireEvent.click(item('文本格式')!);
    await waitFor(() => expect(item('加粗')).toBeTruthy());
    expect(item('文本格式')).toBeUndefined();
    fireEvent.click(item('加粗')!);
    await waitFor(() => expect(view().state.doc.toString()).toBe('**hello** world'));
    expect(document.querySelector('.m-sheet2')).toBeNull();
  });
});

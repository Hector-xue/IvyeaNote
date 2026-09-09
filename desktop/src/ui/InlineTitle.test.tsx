// @vitest-environment jsdom
/**
 * 2026-09-09：新建一篇笔记、在内联标题里敲个名字回车，屏幕上同时弹出
 * 「已重命名：untitled → 测试」和「重命名失败：… untitled.md … 系统找不到指定的文件」。
 *
 * 真因不在文件系统：回车时先 `commit()`，紧接着把焦点交给正文，焦点一走就触发
 * `onBlur`——而这一拍 React 还没重渲染，blur 里的闭包看到的仍是旧的 draft，
 * 于是拿**已经不存在的旧路径**又改了一次名。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { InlineTitle } from './InlineTitle';

afterEach(() => cleanup());

const box = () => document.querySelector('textarea.inline-title') as HTMLTextAreaElement;

describe('内联标题：一次输入只改一次名（v0.11.15）', () => {
  it('回车提交之后紧跟的 blur 不再重复提交', () => {
    const onRename = vi.fn();
    render(<InlineTitle path="untitled.md" doc="" onRename={onRename} />);
    fireEvent.change(box(), { target: { value: '测试' } });
    /*
     * **两个事件必须在同一个 act 里派发。**
     * 真实浏览器上，回车里的 `commit()` 把焦点交给正文，blur 紧接着就来了——
     * React 还没重渲染，blur 的闭包看到的是**上一拍的 draft**。分两次 fireEvent
     * 会在中间把状态刷新掉，那就测不到这个 bug 了（这条用例第一版就是这么写的，
     * 拿旧代码跑照样绿）。
     */
    act(() => {
      fireEvent.keyDown(box(), { key: 'Enter' });
      fireEvent.blur(box());
    });
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith('untitled.md', '测试');
  });

  it('只是点进去又点出去（没改字）不会触发改名', () => {
    const onRename = vi.fn();
    render(<InlineTitle path="untitled.md" doc="" onRename={onRename} />);
    fireEvent.focus(box());
    fireEvent.blur(box());
    expect(onRename).not.toHaveBeenCalled();
  });

  it('改完又改回原名同样不触发', () => {
    const onRename = vi.fn();
    render(<InlineTitle path="a.md" doc="" onRename={onRename} />);
    fireEvent.change(box(), { target: { value: 'b' } });
    fireEvent.change(box(), { target: { value: 'a' } });
    fireEvent.blur(box());
    expect(onRename).not.toHaveBeenCalled();
  });

  it('Esc 放弃草稿：之后的 blur 不该把它提交上去', () => {
    const onRename = vi.fn();
    render(<InlineTitle path="a.md" doc="" onRename={onRename} />);
    fireEvent.change(box(), { target: { value: '不要这个名字' } });
    fireEvent.keyDown(box(), { key: 'Escape' });
    fireEvent.blur(box());
    expect(onRename).not.toHaveBeenCalled();
  });
});

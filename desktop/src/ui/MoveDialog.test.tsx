// @vitest-environment jsdom
/**
 * 「移动到…」选择器。
 *
 * 唯一必须钉死的是那条守卫：**不能把文件夹移进它自己或它的子孙**——
 * 移动是「新路径写入 + 旧路径删除」，目标在源里面的话等于把整棵子树搬没。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MoveDialog } from './MoveDialog';

afterEach(cleanup);

const dirs = ['归档', '归档/2026', '项目', '项目/子'];

/**
 * v0.10.0：目录项前面的 📁 换成了线性图标，不能再靠 emoji 认它们。
 * 改成认 `.move-item` 这个类——它本来就是「一个可选目标」的语义。
 */
function labels(): string[] {
  return [...document.querySelectorAll('.move-item')].map((b) => b.textContent ?? '');
}

describe('目标列表', () => {
  it('总是带上库根目录', () => {
    render(<MoveDialog srcPath="a.md" isDir={false} dirs={dirs} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(labels()[0]).toContain('库根目录');
  });

  it('文件：所有目录都能选', () => {
    render(<MoveDialog srcPath="a.md" isDir={false} dirs={dirs} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(labels()).toHaveLength(dirs.length + 1);
  });

  it('文件夹：自己和自己的子孙不在列表里', () => {
    render(<MoveDialog srcPath="项目" isDir dirs={dirs} onPick={vi.fn()} onClose={vi.fn()} />);
    const t = labels().join('|');
    expect(labels().some((x) => x.trim() === '项目')).toBe(false);
    expect(t).not.toContain('项目/子');
    expect(t).toContain('归档');
  });

  it('同名前缀的兄弟目录不该被误伤（项目2 不是 项目 的子孙）', () => {
    render(
      <MoveDialog srcPath="项目" isDir dirs={['项目', '项目2']} onPick={vi.fn()} onClose={vi.fn()} />
    );
    expect(labels().join('|')).toContain('项目2');
  });

  it('当前所在目录标出来并禁用——移到原地是空操作', () => {
    render(
      <MoveDialog srcPath="项目/一.md" isDir={false} dirs={dirs} onPick={vi.fn()} onClose={vi.fn()} />
    );
    const here = screen.getByText('当前位置').closest('button')!;
    expect((here as HTMLButtonElement).disabled).toBe(true);
    expect(here.textContent).toContain('项目');
  });

  it('库根下的笔记：库根那条是「当前位置」', () => {
    render(<MoveDialog srcPath="a.md" isDir={false} dirs={dirs} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('当前位置').closest('button')!.textContent).toContain('库根目录');
  });
});

describe('交互', () => {
  it('点目标回传目录路径', () => {
    const onPick = vi.fn();
    render(<MoveDialog srcPath="a.md" isDir={false} dirs={dirs} onPick={onPick} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('归档/2026'));
    expect(onPick).toHaveBeenCalledWith('归档/2026');
  });

  it('选库根回传空串（onMovePath 用空串表示库根）', () => {
    const onPick = vi.fn();
    render(<MoveDialog srcPath="项目/一.md" isDir={false} dirs={dirs} onPick={onPick} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('库根目录'));
    expect(onPick).toHaveBeenCalledWith('');
  });

  it('一个文件夹都没有时给出提示而不是空白面板', () => {
    render(<MoveDialog srcPath="a.md" isDir={false} dirs={[]} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/还没有别的文件夹/)).toBeTruthy();
  });

  it('取消调 onClose', () => {
    const onClose = vi.fn();
    render(<MoveDialog srcPath="a.md" isDir={false} dirs={dirs} onPick={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByText('取消'));
    expect(onClose).toHaveBeenCalled();
  });
});

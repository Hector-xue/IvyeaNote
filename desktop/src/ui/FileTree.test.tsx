// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { buildFileTree, displayName, FileTree } from './FileTree';

afterEach(() => cleanup());

describe('buildFileTree', () => {
  it('构建嵌套树，文件夹在前', () => {
    const tree = buildFileTree(['b.md', 'sub/deep/c.md', 'a.md', 'sub/d.md']);
    expect(tree.map((n) => n.name)).toEqual(['sub', 'a.md', 'b.md']); // 文件夹优先
    const sub = tree[0];
    expect(sub.type).toBe('dir');
    expect(sub.children!.map((n) => n.name)).toEqual(['deep', 'd.md']);
  });
  it('空列表返回空数组', () => {
    expect(buildFileTree([])).toEqual([]);
  });
});

describe('displayName', () => {
  it('隐藏 md 后缀', () => {
    expect(displayName('笔记.md', true)).toBe('笔记');
    expect(displayName('x.markdown', true)).toBe('x');
    expect(displayName('图片.png', true)).toBe('图片.png');
    expect(displayName('folder', false)).toBe('folder');
  });
});

describe('FileTree 交互', () => {
  const paths = ['a.md', 'sub/b.md', 'sub/inner/c.md'];

  function Harness() {
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    const [current, setCurrent] = useState<string | null>(null);
    return (
      <FileTree
        nodes={buildFileTree(paths)}
        currentPath={current}
        collapsed={collapsed}
        onToggleDir={(d) =>
          setCollapsed((s) => {
            const n = new Set(s);
            if (n.has(d)) n.delete(d);
            else n.add(d);
            return n;
          })
        }
        onSelectFile={setCurrent}
        onNewNoteIn={() => undefined}
        onNewFolderIn={() => undefined}
        onDeleteFile={() => undefined}
      />
    );
  }

  it('渲染嵌套结构并隐藏后缀', () => {
    render(<Harness />);
    expect(screen.getByText('a')).toBeTruthy();
    expect(screen.getByText('b')).toBeTruthy(); // 初始全展开
    fireEvent.click(screen.getByText('sub')); // 折叠 sub
    expect(screen.queryByText('b')).toBeNull();
  });

  it('点击文件选中（高亮 active）', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('a'));
    expect(screen.getByText('a').closest('.ft-file')?.className).toContain('active');
  });

  it('折叠后再次点击展开', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('sub')); // 折叠
    expect(screen.queryByText('b')).toBeNull();
    fireEvent.click(screen.getByText('sub')); // 展开
    expect(screen.getByText('b')).toBeTruthy();
  });
});

describe('buildFileTree 的空文件夹', () => {
  it('只有 .md 时行为不变', () => {
    const t = buildFileTree(['a.md', '日记/一.md']);
    expect(t.map((n) => `${n.type}:${n.path}`)).toEqual(['dir:日记', 'file:a.md']);
  });

  it('显式目录会出现，即使里面一篇笔记都没有——「新建文件夹」靠这条才可见', () => {
    const t = buildFileTree([], ['项目']);
    expect(t.map((n) => `${n.type}:${n.path}`)).toEqual(['dir:项目']);
    expect(t[0].children).toEqual([]);
  });

  it('显式目录与同名的文件推导目录合并，不产生两个节点', () => {
    const t = buildFileTree(['项目/立项.md'], ['项目']);
    expect(t.filter((n) => n.path === '项目')).toHaveLength(1);
    expect(t[0].children?.map((c) => c.path)).toEqual(['项目/立项.md']);
  });

  it('多层空目录逐级建出来', () => {
    const t = buildFileTree([], ['归档/2026/一季度']);
    expect(t[0].path).toBe('归档');
    expect(t[0].children?.[0].path).toBe('归档/2026');
    expect(t[0].children?.[0].children?.[0].path).toBe('归档/2026/一季度');
  });

  it('空文件夹排在文件前面（与既有排序一致）', () => {
    const t = buildFileTree(['z.md'], ['空']);
    expect(t.map((n) => n.type)).toEqual(['dir', 'file']);
  });
});

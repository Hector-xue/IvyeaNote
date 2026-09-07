// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { buildFileTree, displayName, fileBadge, FileTree } from './FileTree';

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
    expect(displayName('folder', false)).toBe('folder');
  });

  /*
   * v0.11.1 起文件树显示库里的**全部**文件，所以非 Markdown 也去掉后缀，
   * 类型改由右侧角标表达（Obsidian 同款）。留着 `.png` 会让一列文件名参差不齐，
   * 而角标是对齐的、可扫的。
   */
  it('非 Markdown 也去掉后缀，类型交给角标', () => {
    expect(displayName('图片.png', true)).toBe('图片');
    expect(displayName('报表.2026.xlsx', true)).toBe('报表.2026');
    expect(displayName('README', true)).toBe('README');
    expect(displayName('.gitignore', true)).toBe('.gitignore');
  });
});

describe('fileBadge', () => {
  it('Markdown 不给角标——库里绝大多数是笔记，全挂一个 MD 只是噪声', () => {
    expect(fileBadge('笔记.md')).toBeNull();
    expect(fileBadge('x.markdown')).toBeNull();
  });
  it('其余文件给大写后缀', () => {
    expect(fileBadge('手册.pdf')).toBe('PDF');
    expect(fileBadge('图.PNG')).toBe('PNG');
    expect(fileBadge('包.docx')).toBe('DOCX');
  });
  it('没有后缀就没有角标', () => {
    expect(fileBadge('LICENSE')).toBeNull();
  });
});

describe('文件树包含非 Markdown 文件', () => {
  /*
   * v0.11.0 之前树只由 `.md` 构建，PDF 被钉在侧栏最底下一个扁平分组里——
   * `obsidian/文章/x.pdf` 在那儿只剩个文件名、脱离所在目录，用户找不到，
   * 原话是「pdf 依旧识别不到」。这条用例在旧代码上会失败。
   */
  it('PDF 待在它自己的文件夹里，而不是被拍平到根', () => {
    const tree = buildFileTree(['文章/杂记.md', '文章/手册.pdf', '文章/图.png']);
    const dir = tree.find((n) => n.name === '文章')!;
    expect(dir.type).toBe('dir');
    expect(dir.children!.map((n) => n.name).sort()).toEqual(['图.png', '手册.pdf', '杂记.md'].sort());
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

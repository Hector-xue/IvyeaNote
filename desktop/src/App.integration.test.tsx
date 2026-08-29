// @vitest-environment jsdom
/**
 * v0.8.0 集成测试：**验证数据流真的接上了**，而不是各个纯函数各自正确。
 *
 * 为什么单独开一个文件：现有 128 个测试全是纯函数单测，所以 v0.7.x 那类
 * 「解析器对、但数据源从来没喂进去」的缺陷一个都抓不到——
 * 反链解析器 `wikilink.ts` 有测试且全绿，可真机上反链区块从未显示过，
 * 因为全库正文索引只在打开命令面板时建一次、移动端根本没有那个入口。
 *
 * 本文件的每条用例都刻意**不碰命令面板**，只做用户日常动作，
 * 断言最终渲染出来的东西是对的。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FileIO } from './lib/sync';

afterEach(() => {
  cleanup();
});

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

const { memFiles, memIO } = vi.hoisted(() => {
  const memFiles = new Map<string, string>();
  const memIO: FileIO = {
    async list() {
      return [...memFiles.keys()];
    },
    async listMeta() {
      return [...memFiles.keys()].map((p) => ({
        path: p,
        mtime: 0,
        size: memFiles.get(p)!.length,
      }));
    },
    async read(_vp, rel) {
      const v = memFiles.get(rel);
      if (v === undefined) throw new Error(`not found: ${rel}`);
      return v;
    },
    async write(_vp, rel, content) {
      memFiles.set(rel, content);
    },
    async readBinary(_vp, rel) {
      const v = memFiles.get(rel);
      if (v === undefined) throw new Error(`not found: ${rel}`);
      return new TextEncoder().encode(v);
    },
    async writeBinary(_vp, rel, data) {
      memFiles.set(rel, new TextDecoder().decode(data));
    },
    async remove(_vp, rel) {
      memFiles.delete(rel);
    },
    async exists(_vp, rel) {
      return memFiles.has(rel);
    },
  };
  return { memFiles, memIO };
});

vi.mock('./lib/fs-adapters', () => ({
  tauriIO: memIO,
  opfsIO: () => memIO,
  migrateFiles: vi.fn(),
}));

vi.mock('@codemirror/view', () => ({
  EditorView: class {
    setState() {}
    destroy() {}
    static updateListener = { of: () => ({}) };
    static theme = () => ({});
  },
  ViewPlugin: { fromClass: () => ({}) },
  Decoration: {
    none: [],
    set: () => [],
    line: () => ({ range: () => null }),
    mark: () => ({ range: () => null }),
    replace: () => ({ range: () => null }),
  },
  WidgetType: class {},
  keymap: { of: () => ({}) },
  highlightActiveLine: () => ({}),
  drawSelection: () => ({}),
}));
vi.mock('@codemirror/state', () => ({
  EditorState: { create: () => ({}) },
  EditorSelection: { range: () => ({}), cursor: () => ({}) },
  StateEffect: { define: () => ({ of: () => ({}) }) },
  Range: class {},
}));

import App from './App';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ivnote.welcomed', '1');
  memFiles.clear();
});

/** jsdom 没有 DataTransfer：给拖拽事件造一个够用的替身 */
function fakeDataTransfer() {
  const data: Record<string, string> = {};
  return {
    data,
    effectAllowed: '',
    dropEffect: '',
    setData(k: string, v: string) {
      data[k] = v;
    },
    getData(k: string) {
      return data[k] ?? '';
    },
  };
}

async function renderApp(seed: Record<string, string>) {
  for (const [k, v] of Object.entries(seed)) memFiles.set(k, v);
  render(<App />);
  // 等文件树出现（按完整路径定位，避免与 wiki 面板/标签栏里的同名文字撞车）
  const first = Object.keys(seed)[0];
  await waitFor(() => {
    if (!fileNode(first)) throw new Error(`文件树里还没有 ${first}`);
  });
}

/** 文件树里的某个文件节点（用完整路径精确定位：显示名会重名，路径不会） */
function fileNode(path: string): HTMLElement | null {
  return (
    document
      .querySelector<HTMLElement>(`.ft-root .ft-file-name[title="${path}"]`)
      ?.closest('.ft-file') ?? null
  );
}

/** 文件树里的某个文件夹节点 */
function dirNode(name: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>('.ft-root .ft-dir')].find(
      (d) => d.querySelector('.ft-dir-name')?.textContent === name
    ) ?? null
  );
}

/** 在文件树里点开一篇笔记 */
function openNote(path: string) {
  const el = fileNode(path);
  if (!el) throw new Error(`文件树里找不到 ${path}`);
  fireEvent.click(el);
}

// ---------------------------------------------------------------------------

describe('全库正文索引：不打开命令面板也必须是活的', () => {
  it('打开 B → 立刻看到来自 A 的入链（v0.7.4 这里恒为空）', async () => {
    await renderApp({ 'A.md': '# A\n\n看看 [[B]]\n', 'B.md': '# B\n' });

    openNote('B.md');

    // 入链区块出现，且指向 A —— 全程没有按过 Ctrl+K / 打开过标签面板或图谱
    await waitFor(() => {
      expect(screen.getByText('入链')).toBeTruthy();
    });
    const panel = screen.getByText('入链').closest('.wp-row')!;
    expect(panel.textContent).toContain('A');
  });

  it('打开 A → 看到指向 B 的出链', async () => {
    await renderApp({ 'A.md': '# A\n\n看看 [[B]]\n', 'B.md': '# B\n' });

    openNote('A.md');

    await waitFor(() => {
      expect(screen.getByText('出链')).toBeTruthy();
    });
    expect(screen.getByText('出链').closest('.wp-row')!.textContent).toContain('B');
  });

  it('没有人引用时不显示入链区块（避免误报）', async () => {
    await renderApp({ 'A.md': '# A\n', 'B.md': '# B\n' });
    openNote('B.md');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('入链')).toBeNull();
  });

  it('子目录里的笔记同样能建立反链', async () => {
    await renderApp({ 'sub/A.md': '# A\n\n[[B]]\n', 'B.md': '# B\n' });
    openNote('B.md');
    await waitFor(() => {
      expect(screen.getByText('入链')).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------

describe('侧栏拖拽移动（E1）', () => {
  /** 把 srcPath（文件完整路径，或文件夹名）拖到 destName 文件夹上；destName=null 即库根 */
  function dragOnto(srcPath: string, destName: string | null) {
    const dt = fakeDataTransfer();
    const src = fileNode(srcPath) ?? dirNode(srcPath);
    if (!src) throw new Error(`找不到拖拽源：${srcPath}`);
    fireEvent.dragStart(src, { dataTransfer: dt });

    const dest = destName ? dirNode(destName) : document.querySelector<HTMLElement>('.ft-root');
    if (!dest) throw new Error(`找不到落点：${destName}`);
    fireEvent.dragOver(dest, { dataTransfer: dt });
    fireEvent.drop(dest, { dataTransfer: dt });
  }

  it('文件拖进文件夹 → 真的移动了', async () => {
    await renderApp({ 'a.md': '# A\n', 'sub/b.md': '# B\n' });

    dragOnto('a.md', 'sub');

    await waitFor(() => {
      expect(memFiles.has('sub/a.md')).toBe(true);
    });
    expect(memFiles.has('a.md')).toBe(false);
    expect(memFiles.get('sub/a.md')).toBe('# A\n');
  });

  it('文件拖到空白处 → 移回库根', async () => {
    await renderApp({ 'sub/b.md': '# B\n', 'z.md': '# Z\n' });

    dragOnto('sub/b.md', null);

    await waitFor(() => {
      expect(memFiles.has('b.md')).toBe(true);
    });
    expect(memFiles.has('sub/b.md')).toBe(false);
  });

  it('目标同名 → 自动序号，绝不覆盖已有笔记', async () => {
    await renderApp({ 'a.md': '# 根上的 A\n', 'sub/a.md': '# 子目录的 A\n' });

    dragOnto('a.md', 'sub');

    await waitFor(() => {
      expect(memFiles.has('sub/a-2.md')).toBe(true);
    });
    // 原有的 sub/a.md 内容必须完好
    expect(memFiles.get('sub/a.md')).toBe('# 子目录的 A\n');
    expect(memFiles.get('sub/a-2.md')).toBe('# 根上的 A\n');
  });

  it('移动后索引跟着更新：反链仍然正确', async () => {
    await renderApp({ 'A.md': '# A\n\n[[B]]\n', 'B.md': '# B\n', 'sub/keep.md': '# K\n' });

    dragOnto('A.md', 'sub');
    await waitFor(() => {
      expect(memFiles.has('sub/A.md')).toBe(true);
    });

    openNote('B.md');
    await waitFor(() => {
      expect(screen.getByText('入链')).toBeTruthy();
    });
    expect(screen.getByText('入链').closest('.wp-row')!.textContent).toContain('A');
  });
});

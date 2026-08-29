// @vitest-environment jsdom
/**
 * v0.7.5 集成测试：**验证数据流真的接上了**，而不是各个纯函数各自正确。
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
    // 桩要尽量像真的：v0.9.1 的「外部改动回灌」会读 state.doc，
    // 桩里缺了它就会以渲染期异常的形式炸掉整页（真 CM 永远有 state）
    state = { doc: { toString: () => '', length: 0 }, selection: { main: { head: 0 } } };
    dispatch() {}
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
  // phrases 是 v0.7.9 查找面板汉化用到的 facet；桩里缺了会以
  // 「Cannot read properties of undefined (reading 'of')」的形式炸在渲染期
  EditorState: { create: () => ({}), phrases: { of: () => ({}) } },
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

// ---------------------------------------------------------------------------

describe('右键上下文菜单（E3）', () => {
  it('右键文件 → 出现文件动作集（v0.7.8 桌面端根本没有重命名入口）', async () => {
    await renderApp({ 'a.md': '# A\n', 'sub/b.md': '# B\n' });

    fireEvent.contextMenu(fileNode('a.md')!, { clientX: 40, clientY: 60 });

    await waitFor(() => {
      expect(screen.getByRole('menu')).toBeTruthy();
    });
    const labels = [...screen.getAllByRole('menuitem')].map((b) => b.textContent);
    // v0.8.2 E9：「在右侧打开」——分栏里「两文档并排」的主要入口
    // v0.8.3 E3：「移动到…」——方案里点名要的，此前只有拖拽一条路
    expect(labels).toEqual(['打开', '在右侧打开', '重命名…', '移动到…', '复制路径', '删除']);
  });

  it('右键文件夹 → 出现文件夹动作集（不该有「删除笔记」）', async () => {
    await renderApp({ 'sub/b.md': '# B\n' });

    fireEvent.contextMenu(dirNode('sub')!, { clientX: 40, clientY: 60 });

    await waitFor(() => {
      expect(screen.getByRole('menu')).toBeTruthy();
    });
    const labels = [...screen.getAllByRole('menuitem')].map((b) => b.textContent);
    // v0.8.3：文件夹也能「移动到…」（不能移进自己的子孙，由 MoveDialog 守卫）
    expect(labels).toEqual(['在此新建笔记', '在此新建子文件夹', '移动到…', '复制路径']);
  });

  it('Esc 关闭菜单', async () => {
    await renderApp({ 'a.md': '# A\n' });
    fireEvent.contextMenu(fileNode('a.md')!, { clientX: 40, clientY: 60 });
    await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy());

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('点菜单外面关闭', async () => {
    await renderApp({ 'a.md': '# A\n' });
    fireEvent.contextMenu(fileNode('a.md')!, { clientX: 40, clientY: 60 });
    await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy());

    fireEvent.mouseDown(document.querySelector('.ctx-mask')!);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('菜单里点「在此新建笔记」→ 真的在该文件夹下建出来了', async () => {
    await renderApp({ 'sub/b.md': '# B\n' });
    fireEvent.contextMenu(dirNode('sub')!, { clientX: 40, clientY: 60 });
    await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy());

    fireEvent.click(screen.getByText('在此新建笔记'));

    await waitFor(() => {
      expect([...memFiles.keys()].some((p) => p.startsWith('sub/') && p !== 'sub/b.md')).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------

describe('侧栏搜索（E7）', () => {
  function ribbon(label: string): HTMLElement {
    const el = document.querySelector<HTMLElement>(`.ribbon-btn[aria-label="${label}"]`);
    if (!el) throw new Error(`ribbon 里找不到「${label}」`);
    return el;
  }

  it('切到搜索页 → 输入关键词 → 出结果并能点开', async () => {
    await renderApp({
      'AI/agent.md': '# Agent\n\n多智能体协作与编排\n',
      'AI/llm.md': '# LLM\n\n完全无关的内容\n',
      '日记/2026.md': '# 日记\n\n今天研究了多智能体\n',
    });

    fireEvent.click(ribbon('搜索'));
    const input = await screen.findByPlaceholderText('搜索全部笔记…');
    fireEvent.change(input, { target: { value: '多智能体' } });

    await waitFor(() => {
      const hits = document.querySelectorAll('.sp-hit');
      expect(hits.length).toBe(2); // agent.md 与 日记，llm.md 不该出现
    });

    // v0.8.4 E7：结果块内部拆成了「标题」和若干「命中行」两种按钮，
    // 点标题＝打开，点命中行＝打开并跳到那一行
    const head = document.querySelector<HTMLElement>('.sp-hit-head')!;
    fireEvent.click(head);
    // 点开后编辑区状态栏应指向被点的那篇
    await waitFor(() => {
      expect(document.querySelector('.status-bar')?.textContent).toMatch(/\.md/);
    });
  });

  it('命中行是可点的，并标出行号（E7 点击定位到行）', async () => {
    await renderApp({ 'AI/agent.md': '# Agent\n\n多智能体协作与编排\n' });
    fireEvent.click(ribbon('搜索'));
    const input = await screen.findByPlaceholderText('搜索全部笔记…');
    fireEvent.change(input, { target: { value: '多智能体' } });

    const line = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('.sp-line');
      if (!el) throw new Error('没有命中行');
      return el;
    });
    expect(line.tagName).toBe('BUTTON');
    expect(line.querySelector('.sp-line-no')?.textContent).toBe('3');
    fireEvent.click(line);
    await waitFor(() => {
      expect(document.querySelector('.status-bar')?.textContent).toMatch(/agent\.md/);
    });
  });

  it('搜不到时给明确反馈，不是空白', async () => {
    await renderApp({ 'a.md': '# A\n' });
    fireEvent.click(ribbon('搜索'));
    const input = await screen.findByPlaceholderText('搜索全部笔记…');
    fireEvent.change(input, { target: { value: '一定搜不到的词' } });
    await waitFor(() => {
      expect(screen.getByText('没有匹配的笔记')).toBeTruthy();
    });
  });

  it('切回文件页 → 文件树回来', async () => {
    await renderApp({ 'a.md': '# A\n' });
    fireEvent.click(ribbon('搜索'));
    await screen.findByPlaceholderText('搜索全部笔记…');
    fireEvent.click(ribbon('文件'));
    await waitFor(() => {
      expect(fileNode('a.md')).toBeTruthy();
    });
  });
})

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
    // v0.10.2：软换行扩展与 DOM 事件处理器。桩里缺了 domEventHandlers 会在
    // 建实例时抛「is not a function」，整页渲染直接挂——补齐才对得上真 CM
    static lineWrapping = {};
    static domEventHandlers = () => ({});
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

/**
 * v0.10.0：右栏改成「大纲 / 反向链接」两个标签，双链不再默认可见。
 * 下面那些用例守的是「索引是不是活的」——切换方式变了，断言不动。
 */
function openLinksTab() {
  const t = [...document.querySelectorAll<HTMLElement>('.rp-tab')].find((b) =>
    (b.textContent ?? '').startsWith('反向链接')
  );
  if (t) fireEvent.click(t);
}

describe('全库正文索引：不打开命令面板也必须是活的', () => {
  it('打开 B → 立刻看到来自 A 的入链（v0.7.4 这里恒为空）', async () => {
    await renderApp({ 'A.md': '# A\n\n看看 [[B]]\n', 'B.md': '# B\n' });

    openNote('B.md');

    // 入链区块出现，且指向 A —— 全程没有按过 Ctrl+K / 打开过标签面板或图谱
    await waitFor(() => {
      openLinksTab();
      expect(screen.getByText('入链')).toBeTruthy();
    });
    const panel = screen.getByText('入链').closest('.wp-row')!;
    expect(panel.textContent).toContain('A');
  });

  it('打开 A → 看到指向 B 的出链', async () => {
    await renderApp({ 'A.md': '# A\n\n看看 [[B]]\n', 'B.md': '# B\n' });

    openNote('A.md');

    await waitFor(() => {
      openLinksTab();
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
      openLinksTab();
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

  /**
   * v0.10.2 回归：文件夹**展开后的内容区**此前是落区空档——拖到子文件上方松手，
   * 事件一路冒泡到 .ft-root，笔记被移到库根而不是那个文件夹里。
   */
  it('拖到文件夹内容区（子文件上方）→ 落进该文件夹，不是库根', async () => {
    await renderApp({ 'a.md': '# A\n', 'sub/b.md': '# B\n' });

    const dt = fakeDataTransfer();
    const src = fileNode('a.md')!;
    fireEvent.dragStart(src, { dataTransfer: dt });
    const inner = fileNode('sub/b.md')!; // 文件夹里的一个文件，不是文件夹那一行
    fireEvent.dragOver(inner, { dataTransfer: dt });
    fireEvent.drop(inner, { dataTransfer: dt });

    await waitFor(() => {
      expect(memFiles.has('sub/a.md')).toBe(true);
    });
    expect(memFiles.has('a.md')).toBe(false);
  });

  /** 拖到自己所在的文件夹上：不该被祖先接住而移到上一级 */
  it('拖到自己所在的文件夹上 → 原地不动，绝不被移到上一级', async () => {
    await renderApp({ 'sub/b.md': '# B\n', 'sub/c.md': '# C\n' });

    dragOnto('sub/b.md', 'sub');

    await new Promise((r) => setTimeout(r, 30));
    expect(memFiles.has('sub/b.md')).toBe(true);
    expect(memFiles.has('b.md')).toBe(false);
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
      openLinksTab();
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
    // 点开后要能看出现在是哪一篇。
    // v0.10.7：标签栏删掉了，「开着哪一篇」重新回到状态栏左侧（.st-path），
    // 而且写的是**完整库内路径**——它比文件名多说一件事：这篇在哪个目录
    await waitFor(() => {
      expect(document.querySelector('.st-path')?.textContent).toBe('AI/agent.md');
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
      expect(document.querySelector('.st-path')?.textContent).toBe('AI/agent.md');
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

/**
 * v0.10.6：同步与首启这一片的回归护栏。
 *
 * 下面每一条对应的都是**真机上一点就废、而 428 条既有测试全绿**的缺陷——
 * 共同点是它们都不在纯函数里，而在"分支顺序 / state 有没有落盘 / 弹层挂在哪棵树上"。
 */
describe('顶栏删除与插入图片（v0.10.7）', () => {
  function ribbon2(label: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`.ribbon-btn[aria-label="${label}"]`);
  }

  it('顶部标签栏没了，「开着哪一篇」在状态栏左侧', async () => {
    await renderApp({ 'AI/agent.md': '# Agent\n' });
    openNote('AI/agent.md');
    await waitFor(() => {
      expect(document.querySelector('.st-path')?.textContent).toBe('AI/agent.md');
    });
    expect(document.querySelector('.tabs-bar')).toBeNull();
  });

  it('「插入图片」按钮在状态栏那一行——桌面此前一个入口都没有', async () => {
    // 能力从 v0.7.1 就写好了（useAttachments.insertImage + 编辑器 doInsertImage），
    // 但桌面从不渲染工具条、也从不传 exposeFormat，于是那段代码是死的
    await renderApp({ 'a.md': '# A\n' });
    openNote('a.md');
    await waitFor(() => {
      expect(document.querySelector('.status-bar [aria-label="插入图片"]')).toBeTruthy();
    });
  });

  it('接 exposeFormat 不能把渲染带进死循环', async () => {
    /*
     * 接这条线时当场撞上：父组件传的是内联箭头，每次渲染都是新引用，
     * 编辑器那个 effect 依赖它 → 重跑 → setState → 再渲染，永远停不下来
     * （表现是整个测试进程挂死、worker 吃到 1.7GB）。
     * 这里断言渲染能收敛：能稳定读到状态栏，就说明没有在无限重渲染。
     */
    await renderApp({ 'a.md': '# A\n' });
    openNote('a.md');
    await waitFor(() => expect(document.querySelector('.st-path')?.textContent).toBe('a.md'));
    const before = document.querySelector('.status-bar')?.textContent;
    await new Promise((r) => setTimeout(r, 300));
    expect(document.querySelector('.st-path')?.textContent).toBe('a.md');
    expect(document.querySelector('.status-bar')?.textContent).toBe(before);
  });

  it('设置里能选附件存放位置，默认是「与笔记同一个文件夹」', async () => {
    await renderApp({ 'a.md': '# A\n' });
    fireEvent.click(ribbon2('设置')!);
    const btn = await screen.findByText('与笔记同一个文件夹');
    expect(btn.className).toMatch(/\bon\b/);
  });
})

describe('首启与同步（v0.10.6 修复的回归）', () => {
  function ribbon(label: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`.ribbon-btn[aria-label="${label}"]`);
  }

  /** 造一个"已登录 + 有一个云端库"的持久化状态，模拟重启后的冷启动 */
  function seedLoggedIn() {
    localStorage.setItem(
      'ivnote.desktop.state.v1',
      JSON.stringify({
        account: {
          serverUrl: 'http://127.0.0.1:8080',
          email: 'me@example.com',
          userId: 1,
          deviceId: 'dev-1',
          tokens: { access: 'a', refresh: 'r' },
        },
        vaults: {
          '7': { id: 7, name: 'Ivyea Note', localPath: 'opfs://7', cursor: 0, versions: {}, bases: {} },
        },
      })
    );
  }

  it('已登录用户重启后直接进完整界面，而不是没有设置按钮的空壳', async () => {
    // 此前 vaultId 是纯内存 state（初值 null），登录态下 activeVaultId 没有兜底，
    // 于是每次重启都落进 `!vault` 分支：没有设置 / 回收站 / 标签 / 图谱，
    // 「新建笔记」是个 () => undefined，只能先去下拉框里把库重选一遍。
    seedLoggedIn();
    memFiles.set('a.md', '# A\n');
    render(<App />);
    await waitFor(() => {
      expect(ribbon('设置')).toBeTruthy();
    });
    expect(ribbon('回收站')).toBeTruthy();
    expect(localStorage.getItem('ivnote.activeVault')).toBe('7');
  });

  it('选中的笔记库会落盘，下次启动照原样恢复', async () => {
    localStorage.setItem('ivnote.activeVault', '7');
    seedLoggedIn();
    memFiles.set('a.md', '# A\n');
    render(<App />);
    await waitFor(() => expect(ribbon('设置')).toBeTruthy());
    expect(localStorage.getItem('ivnote.activeVault')).toBe('7');
  });

  it('存的库在服务端没了 → 自动落到还剩下的那个，而不是卡成空壳', async () => {
    localStorage.setItem('ivnote.activeVault', '999'); // 已经不存在了
    seedLoggedIn();
    memFiles.set('a.md', '# A\n');
    render(<App />);
    await waitFor(() => expect(ribbon('设置')).toBeTruthy());
    expect(localStorage.getItem('ivnote.activeVault')).toBe('7');
  });

  it('欢迎页「已有账号？登录同步」真的能打开登录页', async () => {
    // 欢迎页那一支排在登录页之前，只 setShowLogin(true) 的话欢迎页原样留着，
    // 点下去像完全没反应——从 v0.4.0 起就这样
    localStorage.removeItem('ivnote.welcomed');
    render(<App />);
    const btn = await screen.findByText('已有账号？登录同步');
    fireEvent.click(btn);
    await waitFor(() => {
      expect(document.querySelector('.login-card')).toBeTruthy();
    });
    expect(document.querySelector('.welcome-card')).toBeNull();
  });

  it('登录页有一个首屏就能看见的返回按钮', async () => {
    localStorage.removeItem('ivnote.welcomed');
    render(<App />);
    fireEvent.click(await screen.findByText('已有账号？登录同步'));
    const back = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('.login-back');
      if (!el) throw new Error('登录页没有返回按钮');
      return el;
    });
    fireEvent.click(back);
    await waitFor(() => {
      expect(document.querySelector('.login-card')).toBeNull();
    });
  });

  it('欢迎页「跳过」不会留下一个空白页面', async () => {
    // 此前 WelcomeView 自己 return null，而 App 那一支照样 early-return，
    // 屏幕上只剩一个空的 .app —— 点一下就白屏，只能刷新
    localStorage.removeItem('ivnote.welcomed');
    memFiles.set('a.md', '# A\n');
    render(<App />);
    fireEvent.click(await screen.findByText('跳过，先随便看看'));
    await waitFor(() => {
      expect(document.querySelector('.ribbon')).toBeTruthy();
    });
    expect(localStorage.getItem('ivnote.welcomed')).toBe('1');
  });
})

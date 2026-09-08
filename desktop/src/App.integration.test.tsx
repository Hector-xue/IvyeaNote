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
      /*
       * **假的不能比真的宽松**：桌面端的 `read` 是 `readTextFile`，遇到不是合法
       * UTF-8 的文件（图片 / PDF）直接抛。以前这个桩照单全收，于是「删图片删不掉」
       * 这类问题在测试里永远看不见。
       */
      if (!/\.(md|markdown|txt)$/i.test(rel)) throw new Error(`stream did not contain valid UTF-8: ${rel}`);
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

/*
 * 同步客户端：整段打桩成一台「空服务器」。
 * 只有 SyncClient 被换掉，ApiError 等其余导出保持真的——sync.ts 要用 instanceof 判 403。
 */
const api = vi.hoisted(() => ({
  calls: { listVaults: 0, createVault: [] as string[] },
  remote: [] as { id: number; name: string }[],
  /** 让同步请求以「登录态过期」失败（401 + refresh_invalid） */
  authExpired: false,
}));
vi.mock('./lib/api', async (orig) => {
  const real = await orig<typeof import('./lib/api')>();
  class FakeSyncClient {
    async registerDevice() {
      return { device_id: 'dev-1' };
    }
    async listVaults() {
      api.calls.listVaults++;
      return { vaults: api.remote.map((v) => ({ ...v, created_at: '' })) };
    }
    async createVault(name: string) {
      api.calls.createVault.push(name);
      const v = { id: 1, name };
      api.remote.push(v);
      return v;
    }
    async push() {
      if (api.authExpired) throw new real.ApiError(401, 'refresh_invalid', 'refresh token 无效或已过期');
      return { results: [] };
    }
    async pullPage(_id: number, cursor: number) {
      if (api.authExpired) throw new real.ApiError(401, 'refresh_invalid', 'refresh token 无效或已过期');
      return { changes: [], next_cursor: cursor };
    }
    async putBlob() {}
  }
  return { ...real, SyncClient: FakeSyncClient };
});

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
  // v0.11.0：编辑态图片解析走 Facet（livePreview 里读它拿解析器）。
  // 桩里缺了会在 import 期就炸掉整个测试文件
  Facet: { define: () => ({ of: () => ({}) }) },
  Range: class {},
}));

import App from './App';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ivnote.welcomed', '1');
  memFiles.clear();
  api.calls = { listVaults: 0, createVault: [] };
  api.remote = [];
  api.authExpired = false;
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

/**
 * 「现在开着哪一篇」——v0.11.4 起显示在顶栏的面包屑里（Obsidian 的 view header
 * 就在那儿），此前在状态栏左侧的 `.st-path`。断言的是同一件事，只是换了位置。
 * 面包屑不带 `.md` 后缀、用 ` / ` 分隔，这里还原成库内路径好和用例里的写法对上。
 */
function openedNotePath(): string | null {
  const crumb = document.querySelector('.top-bar .tb-crumb');
  if (!crumb) return null;
  const parts = [...crumb.querySelectorAll('.tb-dir, .tb-name')].map(
    (e) => (e.textContent ?? '').replace(/\s*\/\s*$/, '')
  );
  return parts.length > 0 ? `${parts.join('/')}.md` : null;
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
    // v0.10.7：标签栏删掉了；v0.11.4 起「开着哪一篇」在顶栏的面包屑里，
    // 而且写的是**完整库内路径**——它比文件名多说一件事：这篇在哪个目录
    await waitFor(() => {
      expect(openedNotePath()).toBe('AI/agent.md');
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
      expect(openedNotePath()).toBe('AI/agent.md');
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

  it('顶部标签栏没了，「开着哪一篇」看得见（v0.11.4 起在顶栏面包屑）', async () => {
    await renderApp({ 'AI/agent.md': '# Agent\n' });
    openNote('AI/agent.md');
    await waitFor(() => {
      expect(openedNotePath()).toBe('AI/agent.md');
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
    await waitFor(() => expect(openedNotePath()).toBe('a.md'));
    const before = document.querySelector('.status-bar')?.textContent;
    await new Promise((r) => setTimeout(r, 300));
    expect(openedNotePath()).toBe('a.md');
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

/**
 * v0.11.1：**PDF 与附件必须出现在文件树里它们自己的文件夹中**。
 *
 * 用户第二次反馈「pdf 依旧识别不到」。核实下来 PDF 一直"在"——只是被钉在侧栏
 * 最底下一个叫「PDF」的扁平分组里：几十篇笔记的库里它被压在整棵树下面老远，
 * 而且 `obsidian/文章/x.pdf` 在那儿只剩一个文件名、脱离了所在目录。
 *
 * 这类缺陷纯函数单测抓不到（`buildFileTree` 本身一直是对的，是**没人把 pdf 喂给它**），
 * 所以用例放在这里：只做用户日常动作（展开文件夹），断言渲染结果。
 * 在 v0.11.0 的代码上这三条都会失败。
 */
describe('文件树显示全部文件（v0.11.1）', () => {
  it('PDF 出现在它所在的文件夹里，而不是被拍平到侧栏底部', async () => {
    await renderApp({
      '文章/杂记.md': '# 杂记\n',
      '文章/手册.pdf': '%PDF-1.4 假装是个 PDF',
    });
    // 文件夹默认展开，PDF 应该和笔记并排
    await waitFor(() => {
      if (!fileNode('文章/手册.pdf')) throw new Error('文件树里没有 PDF');
    });
    // 旧实现那个分组标题不该再存在
    expect(document.querySelector('.pdf-label')).toBeNull();
  });

  it('非 Markdown 文件带类型角标，Markdown 不带', async () => {
    await renderApp({
      '杂记.md': '# 杂记\n',
      '手册.pdf': '%PDF',
      '图.png': 'fake',
    });
    await waitFor(() => {
      if (!fileNode('手册.pdf')) throw new Error('还没渲染出来');
    });
    expect(fileNode('手册.pdf')!.querySelector('.ft-badge')?.textContent).toBe('PDF');
    expect(fileNode('图.png')!.querySelector('.ft-badge')?.textContent).toBe('PNG');
    expect(fileNode('杂记.md')!.querySelector('.ft-badge')).toBeNull();
  });

  it('点 PDF 打开的是 PDF 预览，而不是把它当 Markdown 塞进编辑器', async () => {
    await renderApp({ '杂记.md': '# 杂记\n', '手册.pdf': '%PDF' });
    await waitFor(() => {
      if (!fileNode('手册.pdf')) throw new Error('还没渲染出来');
    });
    fireEvent.click(fileNode('手册.pdf')!);
    await waitFor(() => {
      if (!document.querySelector('.pdf-view')) throw new Error('没有进入 PDF 预览');
    });
    // 预览里显示的是文件名，不是 blob URL（v0.11.0 之前那行面包屑打印的是 blob:）
    expect(document.querySelector('.pdf-name')?.textContent).toBe('手册.pdf');
  });
});

/*
 * 2026-09-08 真机反馈：登录成功，同步一直报「推送失败：vault 不存在或不属于你」。
 *
 * 病根不在同步引擎，在**入口**：把本地库接上云端这段协调只长在 finishLogin 里，
 * 一辈子只在点登录那一刻跑一次。v0.11.5 的 CORS 故障让它整段抛掉之后，
 * state 里只剩负数 id 的本地库、account 却存下了 —— 之后每一轮同步都是 403，
 * 而且**不重新登录就永远不会再协调第二次**。
 * 纯函数单测抓不到这种病（linkVaults 自己是对的），只有"渲染整个 App"能抓。
 */
describe('登录着却没有云端库时自己接回来（v0.11.7）', () => {
  function seedLoggedIn(vault: Record<string, unknown>) {
    localStorage.setItem(
      'ivnote.desktop.state.v1',
      JSON.stringify({
        account: {
          serverUrl: 'https://example.test',
          email: 'u@example.test',
          userId: 9,
          deviceId: 'dev-1',
          tokens: { access: 'a', refresh: 'r' },
        },
        vaults: { [String(vault.id)]: vault },
      })
    );
    localStorage.setItem('ivnote.activeVault', String(vault.id));
  }

  it('打开就把本地库升级成云端库，并保住绑定的磁盘文件夹', async () => {
    seedLoggedIn({
      id: -1,
      name: '我的笔记',
      localPath: 'E:\\obsidian\\obsidian',
      cursor: 0,
      versions: {},
      bases: {},
    });
    memFiles.set('a.md', '# 正文');
    render(<App />);

    await waitFor(() => {
      const st = JSON.parse(localStorage.getItem('ivnote.desktop.state.v1')!);
      if (!st.vaults['1']) throw new Error('还没接上云端库');
    });
    const st = JSON.parse(localStorage.getItem('ivnote.desktop.state.v1')!);
    expect(api.calls.createVault).toEqual(['我的笔记']);
    expect(st.vaults['1'].localPath).toBe('E:\\obsidian\\obsidian');
    expect(st.vaults['-1']).toBeUndefined();
  });

  it('云端已经有库了就并进去，不重复建库', async () => {
    api.remote = [{ id: 4, name: '工作' }];
    seedLoggedIn({ id: -1, name: '我的笔记', localPath: '/data/notes', cursor: 0, versions: {}, bases: {} });
    render(<App />);

    await waitFor(() => {
      const st = JSON.parse(localStorage.getItem('ivnote.desktop.state.v1')!);
      if (!st.vaults['4']) throw new Error('还没并进云端库');
    });
    expect(api.calls.createVault).toEqual([]);
    expect(JSON.parse(localStorage.getItem('ivnote.desktop.state.v1')!).vaults['4'].localPath).toBe(
      '/data/notes'
    );
  });
});

/*
 * 用户 2026-09-08 报的：在 Obsidian 里改了同一篇笔记，Ivyea Note 这边要「重新加载」
 * 才看得到。文件监听从 v0.7.5 就有，但它只调 refreshFiles()——刷的是文件列表和索引，
 * **从不碰编辑区的 doc**。回到前台这条兜底路同样一条都没有。
 */
describe('外部改动要能被看见（v0.11.7）', () => {
  // 状态栏里有两个 .st-count（反向链接数、字数），字数是后面那个
  const countText = () =>
    [...document.querySelectorAll('.status-bar .st-count')].pop()?.textContent ?? '';

  it('回到前台就把磁盘上的新内容读进正在打开的那篇', async () => {
    await renderApp({ 'a.md': '# 标题' });
    openNote('a.md');
    await waitFor(() => {
      if (!countText()) throw new Error('状态栏还没出字数');
    });
    const before = countText();

    // 外部（Obsidian）改了同一个文件
    memFiles.set('a.md', '# 标题\n\n这一段是在别的软件里加的，字数必须跟着变。');
    fireEvent(document, new Event('visibilitychange'));

    await waitFor(() => {
      if (countText() === before) throw new Error(`字数没变：${countText()}`);
    });
  });

});

/*
 * 2026-09-08 真机：「无法删除绑定目录的文件」。删除是"先读出来搬进 .trash 再删原文件"，
 * 而读用的是文本读写 —— 图片 / PDF 过一遍 UTF-8 解码直接抛，于是删不掉；
 * 重名递增又写死成只认 `.md`，非 .md 撞名时那个 while 会原地打转。
 */
describe('删除任何类型的文件（v0.11.7）', () => {
  it('图片能删进回收站（此前文本读写在这一步抛）', async () => {
    await renderApp({ 'a.md': '# A', '图.png': 'PNG-BYTES' });
    fireEvent.click(fileNode('图.png')!.querySelector('button[title="删除"]')!);
    await waitFor(() => {
      if (!document.querySelector('.dlg-card')) throw new Error('确认框没出来');
    });
    fireEvent.click(document.querySelector('.dlg-card .btn.danger')!);

    await waitFor(() => {
      if (fileNode('图.png')) throw new Error('图片还在树里');
    });
    const trashed = [...memFiles.keys()].filter((p) => p.startsWith('.trash/'));
    expect(trashed.length).toBe(1);
    expect(trashed[0]).toMatch(/图\.png$/);
    expect(memFiles.get(trashed[0])).toBe('PNG-BYTES'); // 内容一个字节都没坏
  });
});

/*
 * 手机端 2026-09-08：一条永远消不掉的红条「拉取失败：refresh token 无效或已过期」，
 * 而界面上没有任何一处告诉你该重新登录、也没有能点的入口。
 */
describe('登录态过期要说人话并给出路（v0.11.8）', () => {
  it('同步撞上 401 → 状态栏变成「登录已过期」，点它能唤起登录页', async () => {
    localStorage.setItem(
      'ivnote.desktop.state.v1',
      JSON.stringify({
        account: {
          serverUrl: 'https://example.test',
          email: 'u@example.test',
          userId: 9,
          deviceId: 'dev-1',
          tokens: { access: 'a', refresh: 'r' },
        },
        vaults: {
          '1': { id: 1, name: '云端库', localPath: '/data/notes', cursor: 0, versions: {}, bases: {} },
        },
      })
    );
    localStorage.setItem('ivnote.activeVault', '1');
    api.remote = [{ id: 1, name: '云端库' }];
    api.authExpired = true;
    memFiles.set('a.md', '# A');
    render(<App />);

    const syncBtn = () =>
      [...document.querySelectorAll('.status-bar button')].find((b) =>
        (b.textContent ?? '').includes('登录已过期')
      ) as HTMLElement | undefined;

    await waitFor(
      () => {
        if (!syncBtn()) throw new Error(`状态栏还没提示过期：${document.querySelector('.status-bar')?.textContent}`);
      },
      { timeout: 4000 }
    );
    fireEvent.click(syncBtn()!);
    await waitFor(() => {
      if (!document.querySelector('.login-wrap')) throw new Error('登录页没出来');
    });
  });
});

/*
 * 2026-09-08 用户：「顶部状态栏感觉空空的，能增加一些功能按钮吗？但是不能为了凑数
 * 而凑数，要高频使用的那种」「我的侧边栏也不能收起」「没有汉堡菜单，也没有导出为
 * PDF 的功能」。
 *
 * 所以顶栏只加两样：左边侧栏折叠（Obsidian 就在这个位置），右边「⋯」笔记动作。
 * 已经在别处有按钮的（阅读/编辑、分栏）坚决不重复——用户上一轮的原话是
 * 「页面上下的功能按钮还有重复的」。
 */
describe('顶栏与侧栏（v0.11.8）', () => {
  const sideToggle = () =>
    document.querySelector<HTMLElement>('.top-bar button[aria-label="切换侧边栏"]');
  const moreBtn = () =>
    document.querySelector<HTMLElement>('.top-bar button[aria-label="更多操作"]');

  it('侧边栏能收起、能展开，而且状态记得住', async () => {
    await renderApp({ 'a.md': '# A' });
    expect(document.querySelector('.sidebar')).toBeTruthy();
    const resizersBefore = document.querySelectorAll('.panel-resizer').length;

    fireEvent.click(sideToggle()!);
    await waitFor(() => {
      if (document.querySelector('.sidebar')) throw new Error('侧栏没收起');
    });
    // 连同**侧栏那条**拖宽手柄一起收掉，不留"一条能拖的缝"
    // （右侧面板也有一条同名手柄，所以按数量比，别一竿子打死）
    expect(document.querySelectorAll('.panel-resizer').length).toBe(resizersBefore - 1);
    expect(localStorage.getItem('ivnote.sidebarOpen')).toBe('0');

    fireEvent.click(sideToggle()!);
    await waitFor(() => {
      if (!document.querySelector('.sidebar')) throw new Error('侧栏没展开');
    });
  });

  it('没开笔记时不摆一个点开是空的「⋯」', async () => {
    await renderApp({ 'a.md': '# A' });
    expect(moreBtn()).toBeNull();
  });

  it('开着笔记时「⋯」里有导出 PDF / 重命名 / 删除，且不重复已有的按钮', async () => {
    await renderApp({ 'a.md': '# A' });
    openNote('a.md');
    await waitFor(() => {
      if (!moreBtn()) throw new Error('顶栏没有「⋯」');
    });
    fireEvent.click(moreBtn()!);
    await waitFor(() => {
      if (!document.querySelector('[role="menu"], .ctx-menu')) throw new Error('菜单没出来');
    });
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent);
    expect(labels).toContain('导出为 PDF…');
    expect(labels).toContain('重命名…');
    expect(labels).toContain('删除');
    // 阅读/编辑与分栏在别处已经有按钮了，菜单里不再重复一遍
    expect(labels).not.toContain('阅读视图');
    expect(labels).not.toContain('分栏');
  });
});

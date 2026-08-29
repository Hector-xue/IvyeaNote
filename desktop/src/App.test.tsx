// @vitest-environment jsdom
/**
 * v0.3.3 阶段 0 回归测试：锁死「Windows 上按钮全点不动」的五个根因，防止复发。
 *
 * 覆盖（对应优化方案 R1~R4）：
 * - 免登录本地模式：文件列表不再被 client 门控（R2）
 * - 新建笔记/删除走应用内 Dialog，全程不碰 window.prompt/confirm（R1）
 * - 登录页开关切换不再触发 hooks 数量变化崩溃（R3）
 * - 无账号时上传/拉取按钮显式禁用 + 登录提示，而非静默 no-op（R2）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FileIO } from './lib/sync';

// vitest 未开 globals，RTL 的自动 cleanup 不生效：手动清理，避免用例间 DOM 叠加
afterEach(() => {
  cleanup();
});

// ---------- jsdom 缺 matchMedia：useIsMobile 打桩（固定桌面布局） ----------
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

// ---------- 内存文件系统：替代 OPFS / Tauri fs ----------
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

// ---------- CodeMirror 打桩：jsdom 里只测交互，不起真编辑器 ----------
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
  localStorage.setItem('ivnote.welcomed', '1'); // v0.4.0：跳过首启引导（引导页单独测）
  memFiles.clear();
  memFiles.set('a.md', '# A');
  memFiles.set('sub/b.md', '# B');
});

/** 渲染并等主界面出现（v0.5.0：文件树隐藏后缀，找 'a'） */
async function renderMain() {
  render(<App />);
  await screen.findByText('a');
}

describe('R2：免登录本地模式文件列表不被 client 门控', () => {
  it('无账号启动：侧栏列出本地库全部 .md 文件', async () => {
    await renderMain();
    expect(screen.getByText('a')).toBeTruthy();
    expect(screen.getByText('b')).toBeTruthy();
    // 本地库名出现在笔记库选择器里
    expect(screen.getByText('我的笔记')).toBeTruthy();
  });
});

describe('v0.4.0 T3：即时新建（Obsidian 式）', () => {
  it('点新建直接创建 untitled.md 并落盘，全程不调 window.prompt', async () => {
    const promptSpy = vi.spyOn(window, 'prompt');
    await renderMain();

    fireEvent.click(screen.getByText('＋ 新建笔记'));

    await waitFor(() => expect(memFiles.has('untitled.md')).toBe(true));
    expect(memFiles.get('untitled.md')).toContain('# untitled');
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it('重名自动序号：再建一个变成 untitled 1', async () => {
    memFiles.set('untitled.md', '# untitled');
    await renderMain();
    fireEvent.click(screen.getByText('＋ 新建笔记'));
    await waitFor(() => expect(memFiles.has('untitled 1.md')).toBe(true));
  });
});

describe('v0.4.0 T5：删除进回收站', () => {
  it('删除笔记：确认后移入 .trash/，不调 window.confirm；回收站可恢复', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    await renderMain();

    fireEvent.click(screen.getAllByTitle('删除')[0]);
    expect(await screen.findByText('删除笔记')).toBeTruthy(); // 对话框标题
    fireEvent.click(screen.getByText('删除')); // 确认按钮（红色）

    // v0.5.0 文件树：sub 文件夹排在文件前，第一个删除按钮属于 sub/b.md
    await waitFor(() => expect(memFiles.has('sub/b.md')).toBe(false), { timeout: 3000 });
    expect(memFiles.has('a.md')).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();
    // 原文已进回收站（sub__b.md：目录用 __ 编码）
    const trashKey = [...memFiles.keys()].find((k) => k.startsWith('.trash/') && k.endsWith('-sub__b.md'));
    expect(trashKey).toBeTruthy();
    expect(memFiles.get(trashKey!)).toContain('# B');

    // 回收站面板：恢复
    fireEvent.click(screen.getByText(/回收站/));
    fireEvent.click(await screen.findByText('恢复'));
    await waitFor(() => expect(memFiles.has('sub/b.md')).toBe(true));
  });
});

describe('R2：无账号时同步按钮显式禁用并提示（不再静默 no-op）', () => {
  it('上传/拉取按钮禁用且带「登录后可用」提示', async () => {
    await renderMain();
    // v0.6.1 H7a：按钮收敛为一个「⟳ 同步」
    const gated = screen.getAllByTitle('登录后自动多端同步');
    expect(gated.length).toBe(1);
    for (const b of gated) expect((b as HTMLButtonElement).disabled).toBe(true);
    // 本地模式提示条 + 登录入口
    expect(screen.getAllByText('登录同步').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/本地模式/)).toBeTruthy();
  });
});

describe('R3：登录页开/关不再触发 hooks 数量变化崩溃', () => {
  it('打开登录页再返回，界面正常存活', async () => {
    await renderMain();

    // 打开登录页（此前此操作直接崩白屏）
    fireEvent.click(screen.getAllByText('登录同步')[0]);
    expect(document.querySelector('.login-card')).toBeTruthy();

    // 返回主界面
    fireEvent.click(screen.getByText('先不登录，直接记笔记 →'));
    expect(await screen.findByText('a')).toBeTruthy();
    expect(document.querySelector('.login-card')).toBeNull();
  });
});

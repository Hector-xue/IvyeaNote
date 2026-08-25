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
    async read(_vp, rel) {
      const v = memFiles.get(rel);
      if (v === undefined) throw new Error(`not found: ${rel}`);
      return v;
    },
    async write(_vp, rel, content) {
      memFiles.set(rel, content);
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
    setState() {}
    destroy() {}
    static updateListener = { of: () => ({}) };
  },
  keymap: { of: () => ({}) },
  highlightActiveLine: () => ({}),
  highlightActiveLineGutter: () => ({}),
  lineNumbers: () => ({}),
  drawSelection: () => ({}),
}));
vi.mock('@codemirror/state', () => ({
  EditorState: { create: () => ({}) },
}));

import App from './App';

beforeEach(() => {
  localStorage.clear();
  memFiles.clear();
  memFiles.set('a.md', '# A');
  memFiles.set('sub/b.md', '# B');
});

describe('R2：免登录本地模式文件列表不被 client 门控', () => {
  it('无账号启动：侧栏列出本地库全部 .md 文件', async () => {
    render(<App />);
    expect(await screen.findByText('a.md')).toBeTruthy();
    expect(screen.getByText('b.md')).toBeTruthy();
    // 本地库名出现在笔记库选择器里
    expect(screen.getByText('我的笔记')).toBeTruthy();
  });
});

describe('R1：新建/删除走应用内 Dialog（WebView2 不支持 window.prompt/confirm）', () => {
  it('新建笔记：弹应用内对话框，输入后落盘，全程不调 window.prompt', async () => {
    const promptSpy = vi.spyOn(window, 'prompt');
    render(<App />);
    await screen.findByText('a.md');

    fireEvent.click(screen.getByText('＋ 新建笔记'));
    // 应用内对话框出现（标题 + 占位符）
    const input = await screen.findByPlaceholderText('例：日记/2026-08-24.md');
    fireEvent.change(input, { target: { value: 'new.md' } });
    fireEvent.click(screen.getByText('创建'));

    await waitFor(() => expect(memFiles.has('new.md')).toBe(true));
    expect(memFiles.get('new.md')).toContain('# new');
    expect(promptSpy).not.toHaveBeenCalled();
    // 新文件进入侧栏列表（面包屑也会显示同名，故用 findAll）
    expect((await screen.findAllByText('new.md')).length).toBeGreaterThanOrEqual(1);
  });

  it('新建笔记：校验失败行内报错，不创建文件', async () => {
    render(<App />);
    await screen.findByText('a.md');
    fireEvent.click(screen.getByText('＋ 新建笔记'));
    const input = await screen.findByPlaceholderText('例：日记/2026-08-24.md');
    fireEvent.change(input, { target: { value: 'a.md' } });
    fireEvent.click(screen.getByText('创建'));
    expect(screen.getByText('同名文件已存在')).toBeTruthy();
    expect(memFiles.size).toBe(2); // 没有新文件
  });

  it('删除笔记：弹确认框，确认后删除（不调 window.confirm）', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    render(<App />);
    await screen.findByText('a.md');

    fireEvent.click(screen.getAllByTitle('删除')[0]);
    expect(await screen.findByText('删除笔记')).toBeTruthy(); // 对话框标题
    fireEvent.click(screen.getByText('删除')); // 确认按钮（红色）

    await waitFor(() => expect(memFiles.has('a.md')).toBe(false));
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});

describe('R2：无账号时同步按钮显式禁用并提示（不再静默 no-op）', () => {
  it('上传/拉取按钮禁用且带「登录后可用」提示', async () => {
    render(<App />);
    await screen.findByText('a.md');
    const gated = screen.getAllByTitle('云同步需要登录后可用');
    expect(gated.length).toBe(2); // 上传 + 拉取
    for (const b of gated) expect((b as HTMLButtonElement).disabled).toBe(true);
    // 本地模式提示条 + 登录入口
    expect(screen.getAllByText('登录同步').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/本地模式/)).toBeTruthy();
  });
});

describe('R3：登录页开/关不再触发 hooks 数量变化崩溃', () => {
  it('打开登录页再返回，界面正常存活', async () => {
    render(<App />);
    await screen.findByText('a.md');

    // 打开登录页（此前此操作直接崩白屏）
    fireEvent.click(screen.getAllByText('登录同步')[0]);
    expect(document.querySelector('.login-card')).toBeTruthy();

    // 返回主界面
    fireEvent.click(screen.getByText('先不登录，直接记笔记 →'));
    expect(await screen.findByText('a.md')).toBeTruthy();
    expect(document.querySelector('.login-card')).toBeNull();
  });
});

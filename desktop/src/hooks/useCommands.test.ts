// @vitest-environment jsdom
/**
 * useCommands 的行为锁定。
 *
 * 这块以前散在 App.tsx 三处（面板 state / keydown / 命令表），最容易出的错是
 * 「命令表里有、快捷键点不到」或反过来。测试盯死三件事：
 * 1. 没有笔记库时三个面板都不弹，但 Ctrl+, 的设置照常能开（否则新用户改不了主题）；
 * 2. 条件命令（配对码 / 回收站）该出现时出现、该消失时消失；
 * 3. 快捷键与它对应的面板模式一一对上。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useCommands, type CommandActions } from './useCommands';

function makeActions(over: Partial<CommandActions> = {}): CommandActions {
  return {
    onCreateNote: vi.fn(),
    onCreateFolder: vi.fn(),
    onImportObsidian: vi.fn(),
    onOpenDaily: vi.fn(),
    onOpenGraph: vi.fn(),
    onToggleSplit: vi.fn(),
    onNewFromTemplate: vi.fn(),
    onToggleTheme: vi.fn(),
    onOpenSettings: vi.fn(),
    onCheckUpdate: vi.fn(),
    onAddDevice: null,
    onOpenTrash: null,
    ...over,
  };
}

function setup(
  opts: {
    enabled?: boolean;
    actions?: CommandActions;
    theme?: 'light' | 'dark';
    splitOpen?: boolean;
  } = {}
) {
  const actions = opts.actions ?? makeActions();
  const r = renderHook(() =>
    useCommands({
      enabled: opts.enabled ?? true,
      theme: opts.theme ?? 'light',
      appVersion: '0.8.0',
      splitOpen: opts.splitOpen,
      actions,
    })
  );
  return { ...r, actions };
}

function press(key: string) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('快捷键 → 面板模式', () => {
  it('Ctrl+K 开搜索、Ctrl+O 开切换器、Ctrl+P 开命令', () => {
    const { result } = setup();
    press('k');
    expect(result.current.paletteMode).toBe('search');
    act(() => result.current.closePalette());
    press('o');
    expect(result.current.paletteMode).toBe('switcher');
    act(() => result.current.closePalette());
    press('p');
    expect(result.current.paletteMode).toBe('commands');
  });

  it('closePalette 关掉面板', () => {
    const { result } = setup();
    press('k');
    act(() => result.current.closePalette());
    expect(result.current.paletteMode).toBeNull();
  });

  it('不带 Ctrl/Cmd 的同名按键不触发', () => {
    const { result } = setup();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true }));
    });
    expect(result.current.paletteMode).toBeNull();
  });
});

describe('没有笔记库时（enabled=false）', () => {
  it('三个面板都不弹', () => {
    const { result } = setup({ enabled: false });
    press('k');
    press('o');
    press('p');
    expect(result.current.paletteMode).toBeNull();
    act(() => result.current.openPalette('search'));
    expect(result.current.paletteMode).toBeNull();
  });

  it('但 Ctrl+, 仍然打得开设置——否则新用户连主题都改不了', () => {
    const { actions } = setup({ enabled: false });
    press(',');
    expect(actions.onOpenSettings).toHaveBeenCalledTimes(1);
  });
});

describe('命令表', () => {
  it('未登录 + 无库：不出现「添加设备」和「打开回收站」', () => {
    const { result } = setup();
    const ids = result.current.commands.map((c) => c.id);
    expect(ids).not.toContain('add-device');
    expect(ids).not.toContain('trash');
  });

  it('登录且有库：两条都出现', () => {
    const actions = makeActions({ onAddDevice: vi.fn(), onOpenTrash: vi.fn() });
    const { result } = setup({ actions });
    const ids = result.current.commands.map((c) => c.id);
    expect(ids).toContain('add-device');
    expect(ids).toContain('trash');
  });

  it('主题命令的文案跟着当前主题反向显示', () => {
    const light = setup({ theme: 'light' });
    expect(light.result.current.commands.find((c) => c.id === 'toggle-theme')?.label).toBe(
      '切换到深色主题'
    );
    const dark = setup({ theme: 'dark' });
    expect(dark.result.current.commands.find((c) => c.id === 'toggle-theme')?.label).toBe(
      '切换到浅色主题'
    );
  });

  it('检查更新那条带上当前版本号', () => {
    const { result } = setup();
    expect(result.current.commands.find((c) => c.id === 'check-update')?.label).toBe(
      '检查更新（当前 v0.8.0）'
    );
  });

  it('每条命令的 run 都接到对应动作上', () => {
    const actions = makeActions({ onAddDevice: vi.fn(), onOpenTrash: vi.fn() });
    const { result } = setup({ actions });
    const run = (id: string) => result.current.commands.find((c) => c.id === id)?.run();
    run('new-note');
    run('new-folder');
    run('import-obsidian');
    run('daily');
    run('graph');
    run('split');
    run('from-template');
    run('toggle-theme');
    run('settings');
    run('check-update');
    run('add-device');
    run('trash');
    expect(actions.onCreateNote).toHaveBeenCalled();
    expect(actions.onCreateFolder).toHaveBeenCalled();
    expect(actions.onImportObsidian).toHaveBeenCalled();
    expect(actions.onOpenDaily).toHaveBeenCalled();
    expect(actions.onOpenGraph).toHaveBeenCalled();
    expect(actions.onToggleSplit).toHaveBeenCalled();
    expect(actions.onNewFromTemplate).toHaveBeenCalled();
    expect(actions.onToggleTheme).toHaveBeenCalled();
    expect(actions.onOpenSettings).toHaveBeenCalled();
    expect(actions.onCheckUpdate).toHaveBeenCalled();
    expect(actions.onAddDevice).toHaveBeenCalled();
    expect(actions.onOpenTrash).toHaveBeenCalled();
  });

  it('卸载后快捷键不再生效（监听有摘掉）', () => {
    const { result, unmount, actions } = setup();
    unmount();
    press(',');
    expect(actions.onOpenSettings).not.toHaveBeenCalled();
    expect(result.current.paletteMode).toBeNull();
  });
});

describe('分栏命令（E9）', () => {
  it('未分栏时文案是「开」，已分栏时变成「关」', () => {
    const off = setup({ splitOpen: false });
    expect(off.result.current.commands.find((c) => c.id === 'split')?.label).toBe(
      '左右分栏（当前笔记的实时预览）'
    );
    const on = setup({ splitOpen: true });
    expect(on.result.current.commands.find((c) => c.id === 'split')?.label).toBe('关闭左右分栏');
  });
});

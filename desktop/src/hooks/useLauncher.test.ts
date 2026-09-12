// @vitest-environment jsdom
/**
 * 安卓桌面入口的行为锁定（原生层用 mock 替掉，只测 App 这一侧的时序与分流）。
 *
 * 最容易出错的几条：
 * - 「新建」必须等文件列表到了才做（否则可能覆盖已有的 untitled.md）；
 * - 要开的笔记在别的库：先切库，等新库列表到了再开，切一次没成就落到当前库试；
 * - 太旧的动作丢掉；要开的笔记没了要说清楚；
 * - 有动作待执行时，启动还原要让路（hasPendingAction）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { BoundNote, LaunchAction, NoteSnapshot, PinResult, RebindOp, ShortcutSpec } from '../lib/launcher';

// mock 的签名要和真函数一致：vi.fn(async () => {}) 会把参数推成 []，
// 下面 mock.calls[0][0] 在 tsc 下就是"空元组取下标"的类型错。
const native = vi.hoisted(() => ({
  available: true,
  queue: [] as LaunchAction[],
  listeners: [] as Array<() => void>,
  setShortcuts: vi.fn<(shortcuts: ShortcutSpec[]) => Promise<void>>(async () => {}),
  setNoteSnapshot: vi.fn<(snapshot: NoteSnapshot) => Promise<void>>(async () => {}),
  boundNotes: vi.fn<() => Promise<BoundNote[]>>(async () => []),
  rebindNotes: vi.fn<(ops: RebindOp[]) => Promise<void>>(async () => {}),
  pinNoteWidget: vi.fn<(snapshot: NoteSnapshot) => Promise<PinResult>>(async () => ({ mode: 'requested', count: 0 })),
}));

vi.mock('../lib/launcher', async () => {
  const real = await vi.importActual<typeof import('../lib/launcher')>('../lib/launcher');
  return {
    ...real,
    launcherAvailable: () => native.available,
    takeLaunchAction: async () => native.queue.shift() ?? null,
    onLaunchAction: async (cb: () => void) => {
      native.listeners.push(cb);
      return () => {};
    },
    setShortcuts: native.setShortcuts,
    setNoteSnapshot: native.setNoteSnapshot,
    boundNotes: native.boundNotes,
    rebindNotes: native.rebindNotes,
    pinNoteWidget: native.pinNoteWidget,
  };
});

import { useLauncher, type LauncherDeps } from './useLauncher';

function vaultMeta(id: number) {
  return { id, name: `v${id}`, cursor: 0, versions: {}, bases: {}, localPath: `opfs://${id}` } as LauncherDeps['vault'];
}

function makeDeps(over: Partial<LauncherDeps> = {}): LauncherDeps {
  return {
    vault: vaultMeta(-1),
    canSwitchTo: () => false,
    knowsVault: () => true,
    switchVault: vi.fn(),
    io: {
      list: async () => [],
      listMeta: async () => [],
      read: async () => '# x',
      write: async () => {},
      readBinary: async () => new Uint8Array(),
      writeBinary: async () => {},
      remove: async () => {},
      exists: async () => true,
    },
    files: ['a.md', 'b.md'],
    filesLoaded: true,
    mdStamps: [],
    metaOf: () => undefined,
    recent: [],
    currentPath: null,
    doc: null,
    openInTab: vi.fn(),
    createNote: vi.fn(),
    openDaily: vi.fn(),
    toast: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  native.available = true;
  native.queue = [];
  native.listeners = [];
  vi.clearAllMocks();
});
// 没开 globals 时 RTL 不会自动卸载：上一条用例的 hook 还挂着，它的防抖定时器会串进下一条的断言
afterEach(cleanup);

const now = () => Date.now();

describe('useLauncher：领动作并执行', () => {
  it('「新建」要等文件列表到了才做', async () => {
    native.queue.push({ kind: 'new', vaultId: 0, path: '', at: now() });
    const deps = makeDeps({ filesLoaded: false });
    const { result, rerender } = renderHook((d: LauncherDeps) => useLauncher(d), { initialProps: deps });
    await waitFor(() => expect(result.current.hasPendingAction()).toBe(true));
    expect(deps.createNote).not.toHaveBeenCalled();
    rerender({ ...deps, filesLoaded: true });
    await waitFor(() => expect(deps.createNote).toHaveBeenCalledTimes(1));
    expect(result.current.hasPendingAction()).toBe(false);
  });

  it('「打开」：在库里就开，不在了就提示', async () => {
    native.queue.push({ kind: 'open', vaultId: -1, path: 'b.md', at: now() });
    const deps = makeDeps();
    renderHook(() => useLauncher(deps));
    await waitFor(() => expect(deps.openInTab).toHaveBeenCalledWith('b.md'));

    native.queue.push({ kind: 'open', vaultId: -1, path: 'gone.md', at: now() });
    const deps2 = makeDeps();
    renderHook(() => useLauncher(deps2));
    await waitFor(() => expect(deps2.toast).toHaveBeenCalled());
    expect(String((deps2.toast as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain('gone');
    expect(deps2.openInTab).not.toHaveBeenCalled();
  });

  it('要开的笔记在别的库：先切库，新库列表到了再开', async () => {
    native.queue.push({ kind: 'open', vaultId: 7, path: 'c.md', at: now() });
    const deps = makeDeps({ canSwitchTo: (id) => id === 7 });
    const { rerender } = renderHook((d: LauncherDeps) => useLauncher(d), { initialProps: deps });
    await waitFor(() => expect(deps.switchVault).toHaveBeenCalledWith(7));
    expect(deps.openInTab).not.toHaveBeenCalled();
    // 切过去了，列表还没到
    rerender({ ...deps, vault: vaultMeta(7), filesLoaded: false, files: [] });
    expect(deps.openInTab).not.toHaveBeenCalled();
    rerender({ ...deps, vault: vaultMeta(7), filesLoaded: true, files: ['c.md'] });
    await waitFor(() => expect(deps.openInTab).toHaveBeenCalledWith('c.md'));
    expect(deps.switchVault).toHaveBeenCalledTimes(1);
  });

  it('切不过去的库（没登录的云端库）不切，直接在当前库里试', async () => {
    native.queue.push({ kind: 'open', vaultId: 9, path: 'a.md', at: now() });
    const deps = makeDeps({ canSwitchTo: () => false });
    renderHook(() => useLauncher(deps));
    await waitFor(() => expect(deps.openInTab).toHaveBeenCalledWith('a.md'));
    expect(deps.switchVault).not.toHaveBeenCalled();
  });

  it('太旧的动作丢掉；「只是打开应用」什么都不做', async () => {
    native.queue.push({ kind: 'new', vaultId: 0, path: '', at: now() - 10 * 60 * 1000 });
    native.queue.push({ kind: 'app', vaultId: 0, path: '', at: now() });
    const deps = makeDeps();
    const { result } = renderHook(() => useLauncher(deps));
    // 让两次领取都跑完
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(deps.createNote).not.toHaveBeenCalled();
    expect(result.current.hasPendingAction()).toBe(false);
  });

  it('应用活着时原生推事件 → 再领一次并执行', async () => {
    const deps = makeDeps();
    renderHook(() => useLauncher(deps));
    await waitFor(() => expect(native.listeners.length).toBe(1));
    native.queue.push({ kind: 'daily', vaultId: 0, path: '', at: now() });
    act(() => native.listeners[0]());
    await waitFor(() => expect(deps.openDaily).toHaveBeenCalledTimes(1));
  });

  it('非安卓平台：全部 no-op，不碰原生', async () => {
    native.available = false;
    native.queue.push({ kind: 'new', vaultId: 0, path: '', at: now() });
    const deps = makeDeps({ recent: ['a.md'], currentPath: 'a.md', doc: 'hi' });
    const { result } = renderHook(() => useLauncher(deps));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(result.current.enabled).toBe(false);
    expect(deps.createNote).not.toHaveBeenCalled();
    expect(native.setShortcuts).not.toHaveBeenCalled();
    expect(native.setNoteSnapshot).not.toHaveBeenCalled();
    result.current.notePersisted('a.md', 'x');
    result.current.remapBindings([{ from: 'a.md', to: 'b.md' }]);
    await result.current.pinToHome('a.md');
    expect(native.rebindNotes).not.toHaveBeenCalled();
    expect(native.pinNoteWidget).not.toHaveBeenCalled();
  });
});

describe('useLauncher：快捷方式与快照', () => {
  it('列表就绪后发布快捷方式：新建 / 日记 / 最近两篇', async () => {
    const deps = makeDeps({ recent: ['b.md', 'zz.md', 'a.md'] });
    renderHook(() => useLauncher(deps));
    await waitFor(() => expect(native.setShortcuts).toHaveBeenCalled(), { timeout: 3000 });
    const specs = native.setShortcuts.mock.calls[0][0];
    expect(specs.map((s) => s.kind)).toEqual(['new', 'daily', 'open', 'open']);
    expect(specs.map((s) => s.path)).toEqual(['', '', 'b.md', 'a.md']);
  });

  it('打开一篇 → 推"最近"快照；落盘 → 再推；预览剥掉了 Markdown 记号', async () => {
    const deps = makeDeps({ currentPath: 'a.md', doc: '# 标题\n\n- [ ] 事项' });
    const { result } = renderHook(() => useLauncher(deps));
    await waitFor(() => expect(native.setNoteSnapshot).toHaveBeenCalledTimes(1));
    const snap = native.setNoteSnapshot.mock.calls[0][0];
    expect(snap).toMatchObject({ vaultId: -1, title: 'a', preview: '标题\n\n☐ 事项', recent: true });

    result.current.notePersisted('a.md', '改了');
    await waitFor(() => expect(native.setNoteSnapshot).toHaveBeenCalledTimes(2));
    expect(native.setNoteSnapshot.mock.calls[1][0]).toMatchObject({ preview: '改了', recent: true });
  });

  it('被钉的笔记指纹变了才重推；库 id 已不存在的绑定改绑到当前库', async () => {
    native.boundNotes.mockResolvedValue([
      { vaultId: -1, path: 'a.md' },
      { vaultId: -99, path: 'b.md' },
    ]);
    const read = vi.fn(async (_root: string, p: string) => `内容 ${p}`);
    const deps = makeDeps({
      knowsVault: (id) => id !== -99,
      mdStamps: [
        { path: 'a.md', mtime: 1, size: 1 },
        { path: 'b.md', mtime: 1, size: 1 },
      ],
      io: { ...makeDeps().io, read },
    });
    const { rerender } = renderHook((d: LauncherDeps) => useLauncher(d), { initialProps: deps });
    await waitFor(() => expect(native.setNoteSnapshot).toHaveBeenCalledTimes(2));
    expect(native.rebindNotes).toHaveBeenCalledWith([{ fromVaultId: -99, from: 'b.md', toVaultId: -1, to: 'b.md' }]);
    const pushed = native.setNoteSnapshot.mock.calls.map((c) => c[0].path).sort();
    expect(pushed).toEqual(['a.md', 'b.md']);

    // 指纹没变：不重推
    rerender({ ...deps, mdStamps: [...deps.mdStamps] });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(native.setNoteSnapshot).toHaveBeenCalledTimes(2);

    // a.md 变了：只重推它
    rerender({ ...deps, mdStamps: [{ path: 'a.md', mtime: 2, size: 5 }, { path: 'b.md', mtime: 1, size: 1 }] });
    await waitFor(() => expect(native.setNoteSnapshot).toHaveBeenCalledTimes(3));
    expect(native.setNoteSnapshot.mock.calls[2][0]).toMatchObject({ path: 'a.md', preview: '内容 a.md' });

    // a.md 没了：推一条"已删除"
    rerender({ ...deps, mdStamps: [{ path: 'b.md', mtime: 1, size: 1 }] });
    await waitFor(() => expect(native.setNoteSnapshot).toHaveBeenCalledTimes(4));
    expect(String(native.setNoteSnapshot.mock.calls[3][0].preview)).toContain('已被删除');
  });

  it('添加到桌面：按原生返回的三种结果给不同回执', async () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useLauncher(deps));
    await result.current.pinToHome('a.md');
    expect(native.pinNoteWidget).toHaveBeenCalledWith(expect.objectContaining({ vaultId: -1, path: 'a.md', title: 'a' }));
    expect(deps.toast).not.toHaveBeenCalled(); // requested：系统自己弹框

    native.pinNoteWidget.mockResolvedValueOnce({ mode: 'bound', count: 2 });
    await result.current.pinToHome('a.md');
    expect(String((deps.toast as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain('2 张');

    native.pinNoteWidget.mockResolvedValueOnce({ mode: 'pending', count: 0 });
    await result.current.pinToHome('a.md');
    expect(String((deps.toast as ReturnType<typeof vi.fn>).mock.calls[1][0])).toContain('添加小部件');

    native.pinNoteWidget.mockRejectedValueOnce(new Error('boom'));
    await result.current.pinToHome('a.md');
    expect((deps.toast as ReturnType<typeof vi.fn>).mock.calls[2][1]).toBe('error');
  });
});

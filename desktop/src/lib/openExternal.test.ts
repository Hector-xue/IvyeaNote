import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = { open: [] as string[], reveal: [] as string[] };
let openFails = false;
let revealFails = false;

vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: async (p: string) => {
    calls.open.push(p);
    // Windows 上 .base 这类没有关联程序的文件，系统给的就是这句
    if (openFails) throw new Error('电脑上没有可用应用');
  },
  revealItemInDir: async (p: string) => {
    calls.reveal.push(p);
    if (revealFails) throw new Error('定位失败');
  },
}));

const { openWithSystem, baseNameOf } = await import('./openExternal');

beforeEach(() => {
  calls.open = [];
  calls.reveal = [];
  openFails = false;
  revealFails = false;
});

describe('openWithSystem', () => {
  it('能打开就直接打开，不去打扰文件管理器', async () => {
    expect(await openWithSystem('E:\\v\\a.pdf')).toBe('opened');
    expect(calls.reveal).toEqual([]);
  });

  it('系统没有关联程序（.base）→ 退回到在文件夹中定位', async () => {
    openFails = true;
    expect(await openWithSystem('E:\\v\\个人空间.base')).toBe('revealed');
    expect(calls.reveal).toEqual(['E:\\v\\个人空间.base']);
  });

  it('连定位都失败 → 抛**原始**错误（别拿"定位失败"盖住真正的原因）', async () => {
    openFails = true;
    revealFails = true;
    await expect(openWithSystem('E:\\v\\x.base')).rejects.toThrow('没有可用应用');
  });

  it('文件名两种分隔符都认', () => {
    expect(baseNameOf('E:\\v\\个人空间.base')).toBe('个人空间.base');
    expect(baseNameOf('/home/u/v/a.pdf')).toBe('a.pdf');
    expect(baseNameOf('a.md')).toBe('a.md');
  });
});

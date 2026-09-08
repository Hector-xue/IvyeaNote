import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = { open: [] as string[], reveal: [] as string[], url: [] as string[] };
let openFails = false;
let revealFails = false;
let urlFails = false;

vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: async (p: string) => {
    calls.open.push(p);
    // Windows 上 .base 这类没有关联程序的文件，系统给的就是这句
    if (openFails) throw new Error('电脑上没有可用应用');
  },
  openUrl: async (u: string) => {
    calls.url.push(u);
    if (urlFails) throw new Error('没有注册 obsidian:// 协议');
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
  calls.url = [];
  openFails = false;
  revealFails = false;
  urlFails = false;
});

describe('openWithSystem', () => {
  it('能打开就直接打开，不去打扰文件管理器', async () => {
    expect(await openWithSystem('E:\\v\\a.pdf')).toBe('opened');
    expect(calls.reveal).toEqual([]);
  });

  it('.base 打不开时先交给 Obsidian（它注册了 obsidian:// 协议）', async () => {
    openFails = true;
    expect(await openWithSystem('E:\\v\\个人空间.base')).toBe('obsidian');
    expect(calls.url[0]).toContain('obsidian://open?path=');
    expect(calls.reveal).toEqual([]); // 交出去了就别再打扰文件管理器
  });

  it('没装 Obsidian → 再退回到在文件夹中定位', async () => {
    openFails = true;
    urlFails = true;
    expect(await openWithSystem('E:\\v\\个人空间.base')).toBe('revealed');
    expect(calls.reveal).toEqual(['E:\\v\\个人空间.base']);
  });

  it('普通文件打不开时不去骚扰 Obsidian', async () => {
    openFails = true;
    expect(await openWithSystem('E:\\v\\报表.xlsx')).toBe('revealed');
    expect(calls.url).toEqual([]);
  });

  it('连定位都失败 → 抛**原始**错误（别拿"定位失败"盖住真正的原因）', async () => {
    openFails = true;
    revealFails = true;
    await expect(openWithSystem('E:\\v\\报表.xlsx')).rejects.toThrow('没有可用应用');
  });

  it('文件名两种分隔符都认', () => {
    expect(baseNameOf('E:\\v\\个人空间.base')).toBe('个人空间.base');
    expect(baseNameOf('/home/u/v/a.pdf')).toBe('a.pdf');
    expect(baseNameOf('a.md')).toBe('a.md');
  });
});

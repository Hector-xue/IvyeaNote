/**
 * 桌面（Tauri）适配器在 **Windows** 上的两条硬约束。
 *
 * ① v0.11.4 把 `join` 在 Windows 上改成反斜杠，`parentOf` 却还只找 `/`——
 *    父目录恒为空串，`write`/`writeBinary` 里的 `mkdir(dir,{recursive:true})` 整句被跳过。
 *    后果是**凡是要新建目录的写入全废**：第一次删除笔记（写 `.trash/…`）、
 *    新建文件夹（写 `子目录/.keep`）、往新子目录粘图、同步拉取远端新目录下的笔记。
 * ② `.git` / `.obsidian` 这类点目录不该被扫进来（Obsidian 也是隐藏的）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = { mkdir: [] as string[], written: [] as string[] };
const tree: Record<string, { name: string; isDirectory: boolean }[]> = {};

vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: async (abs: string) => tree[abs] ?? [],
  readTextFile: async () => '',
  writeTextFile: async (abs: string) => {
    calls.written.push(abs);
  },
  readFile: async () => new Uint8Array(),
  writeFile: async (abs: string) => {
    calls.written.push(abs);
  },
  remove: async () => undefined,
  exists: async () => false,
  mkdir: async (abs: string) => {
    calls.mkdir.push(abs);
  },
  stat: async () => ({ mtime: new Date(0), size: 1 }),
}));

// SEP 是模块加载时按 userAgent 定的，必须先伪装成 Windows 再 import
vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) WebView2' });
const { tauriIO, isSkippedDir, inSkippedDir } = await import('./fs-adapters');

beforeEach(() => {
  calls.mkdir = [];
  calls.written = [];
  for (const k of Object.keys(tree)) delete tree[k];
});

describe('Windows 路径', () => {
  it('写回收站时会先建出 .trash 目录（不建 = 删除笔记必然失败）', async () => {
    await tauriIO.write('E:\\obsidian\\obsidian', '.trash/2026-01-01T00-00-00-a.md', '内容');
    expect(calls.mkdir).toEqual(['E:\\obsidian\\obsidian\\.trash']);
    expect(calls.written).toEqual(['E:\\obsidian\\obsidian\\.trash\\2026-01-01T00-00-00-a.md']);
  });

  it('写子目录里的附件同样先建目录', async () => {
    await tauriIO.writeBinary('E:\\v', '图片/a.png', new Uint8Array([1]));
    expect(calls.mkdir).toEqual(['E:\\v\\图片']);
  });

  it('库根下的文件不会去 mkdir 一个盘符', async () => {
    await tauriIO.write('E:\\v', 'a.md', 'x');
    expect(calls.mkdir).toEqual(['E:\\v']);
  });
});

describe('点目录', () => {
  it('.git / .obsidian 不进文件列表，.trash / .ivyea 照常进', async () => {
    tree['E:\\v'] = [
      { name: 'a.md', isDirectory: false },
      { name: '.git', isDirectory: true },
      { name: '.obsidian', isDirectory: true },
      { name: '.trash', isDirectory: true },
      { name: '子目录', isDirectory: true },
    ];
    tree['E:\\v\\.git'] = [{ name: 'HEAD', isDirectory: false }];
    tree['E:\\v\\.obsidian'] = [{ name: 'workspace.json', isDirectory: false }];
    tree['E:\\v\\.trash'] = [{ name: '2026-01-01T00-00-00-b.md', isDirectory: false }];
    tree['E:\\v\\子目录'] = [{ name: 'c.md', isDirectory: false }];

    expect((await tauriIO.list('E:\\v')).sort()).toEqual(
      ['.trash/2026-01-01T00-00-00-b.md', 'a.md', '子目录/c.md'].sort()
    );
  });

  it('判定本身', () => {
    expect(isSkippedDir('.git')).toBe(true);
    expect(isSkippedDir('.obsidian')).toBe(true);
    expect(isSkippedDir('.trash')).toBe(false);
    expect(isSkippedDir('.ivyea')).toBe(false);
    expect(isSkippedDir('笔记')).toBe(false);
    expect(inSkippedDir('.obsidian/plugins/x/main.js')).toBe(true);
    expect(inSkippedDir('.trash/a.md')).toBe(false);
    // 文件名以点开头（.gitignore）不算目录，照常收进来
    expect(inSkippedDir('.gitignore')).toBe(false);
  });
});

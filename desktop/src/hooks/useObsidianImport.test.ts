/**
 * Obsidian 导入的两个纯函数。
 *
 * 这两处正是「两条路各写一遍」漂出来的地方：`webkitRelativePath` 要不要去掉第一段、
 * 结果文案里的数字怎么算。抽出来之后先把口径钉死。
 */
import { describe, expect, it } from 'vitest';
import { entriesFromPickedFiles, importMessage } from './useObsidianImport';

function file(name: string, relPath?: string): File {
  const f = new File(['x'], name, { type: 'text/markdown' });
  if (relPath) Object.defineProperty(f, 'webkitRelativePath', { value: relPath });
  return f;
}

describe('entriesFromPickedFiles', () => {
  it('去掉 webkitRelativePath 的第一段（用户选的那个文件夹名本身）', () => {
    const out = entriesFromPickedFiles([file('一.md', 'MyVault/日记/一.md')]);
    expect(out.map((e) => e.rel)).toEqual(['日记/一.md']);
  });

  it('库根目录下的笔记不带目录前缀', () => {
    const out = entriesFromPickedFiles([file('首页.md', 'MyVault/首页.md')]);
    expect(out.map((e) => e.rel)).toEqual(['首页.md']);
  });

  it('没有 webkitRelativePath 时退回文件名', () => {
    expect(entriesFromPickedFiles([file('孤儿.md')]).map((e) => e.rel)).toEqual(['孤儿.md']);
  });

  it('只收 .md / .markdown，其它一律不导', () => {
    const out = entriesFromPickedFiles([
      file('a.md', 'V/a.md'),
      file('b.markdown', 'V/b.markdown'),
      file('c.txt', 'V/c.txt'),
      file('d.png', 'V/d.png'),
    ]);
    expect(out.map((e) => e.rel)).toEqual(['a.md', 'b.markdown']);
  });
});

describe('importMessage', () => {
  it('全成功且已登录：提示会继续同步', () => {
    expect(importMessage(12, [], true)).toEqual({
      msg: '已从 Obsidian 导入 12 个笔记，正在同步到服务器…',
      kind: 'ok',
    });
  });

  it('全成功但未登录：不提同步', () => {
    expect(importMessage(3, [], false)).toEqual({
      msg: '已从 Obsidian 导入 3 个笔记',
      kind: 'ok',
    });
  });

  it('有失败：报成功数、失败数与第一个失败的文件，且是 error 口径', () => {
    expect(importMessage(8, ['坏/一.md', '坏/二.md'], true)).toEqual({
      msg: '导入完成：成功 8 个，失败 2 个（首个失败：坏/一.md）',
      kind: 'error',
    });
  });

  it('一个都没导入也不崩', () => {
    expect(importMessage(0, [], false).msg).toBe('已从 Obsidian 导入 0 个笔记');
  });
});

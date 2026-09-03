import { describe, expect, it } from 'vitest';
import {
  attachmentDir,
  dirOf,
  encodeHref,
  joinPath,
  noteRelative,
} from './attachPath';

describe('附件落点', () => {
  it('库根模式：永远是库根的 Attachments/', () => {
    expect(attachmentDir('vault', 'a.md')).toBe('Attachments');
    expect(attachmentDir('vault', '项目/子/周报.md')).toBe('Attachments');
  });

  it('同目录模式：跟着笔记走；笔记在库根时就是库根', () => {
    expect(attachmentDir('beside', '项目/周报.md')).toBe('项目');
    expect(attachmentDir('beside', 'a.md')).toBe('');
  });

  it('子文件夹模式：笔记同级的 Attachments/', () => {
    expect(attachmentDir('subfolder', '项目/周报.md')).toBe('项目/Attachments');
    expect(attachmentDir('subfolder', 'a.md')).toBe('Attachments');
  });

  it('还没打开笔记时一律退回库根，不落进意外的地方', () => {
    expect(attachmentDir('beside', null)).toBe('Attachments');
    expect(attachmentDir('subfolder', null)).toBe('Attachments');
  });

  it('dirOf / joinPath 在库根时不留多余斜杠', () => {
    expect(dirOf('a.md')).toBe('');
    expect(dirOf('x/y/a.md')).toBe('x/y');
    expect(joinPath('', 'a.png')).toBe('a.png');
    expect(joinPath('x', 'a.png')).toBe('x/a.png');
  });
});

describe('正文里写什么（笔记相对，不是库根相对）', () => {
  it('同目录：直接写文件名，不带多余的 ./', () => {
    expect(noteRelative('项目/周报.md', '项目/图.png')).toBe('图.png');
  });

  it('库根的笔记指库根的附件夹', () => {
    expect(noteRelative('a.md', 'Attachments/图.png')).toBe('Attachments/图.png');
  });

  it('**这条就是那个 bug**：子目录里的笔记必须上跳，不能光写 Attachments/', () => {
    // 旧代码写的是 'Attachments/图.png'，Obsidian 会去找 项目/Attachments/图.png
    expect(noteRelative('项目/周报.md', 'Attachments/图.png')).toBe('../Attachments/图.png');
    expect(noteRelative('项目/子/周报.md', 'Attachments/图.png')).toBe('../../Attachments/图.png');
  });

  it('同级子文件夹', () => {
    expect(noteRelative('项目/周报.md', '项目/Attachments/图.png')).toBe('Attachments/图.png');
  });

  it('横跨目录', () => {
    expect(noteRelative('a/b/n.md', 'a/c/图.png')).toBe('../c/图.png');
  });

  it('空格和圆括号会撑破 ](…) 语法，必须编码；中文原样留着', () => {
    expect(encodeHref('我的 图(1).png')).toBe('我的%20图%281%29.png');
    expect(encodeHref('中文图.png')).toBe('中文图.png');
  });
});

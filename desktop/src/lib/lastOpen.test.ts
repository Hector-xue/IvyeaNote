import { describe, expect, it } from 'vitest';
import { pickRestore } from './lastOpen';

describe('pickRestore（启动还原上次那篇）', () => {
  const files = ['一.md', '子目录/二.md', '手册.pdf'];

  it('记着的那篇还在，就还原它', () => {
    expect(pickRestore('子目录/二.md', files, null)).toBe('子目录/二.md');
  });

  it('文件已经不在了就不还原（否则打开一个不存在的路径然后弹报错）', () => {
    expect(pickRestore('已删除.md', files, null)).toBeNull();
  });

  it('已经打开了别的笔记就不抢', () => {
    expect(pickRestore('一.md', files, '别的.md')).toBeNull();
  });

  it('没记过就什么也不做', () => {
    expect(pickRestore(null, files, null)).toBeNull();
  });

  it('只还原 Markdown：启动就弹一个 PDF 太吓人', () => {
    expect(pickRestore('手册.pdf', files, null)).toBeNull();
  });
});

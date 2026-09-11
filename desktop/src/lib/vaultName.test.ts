import { describe, it, expect } from 'vitest';
import { folderName, safDisplayPath, vaultDisplayName, vaultLocationLabel } from './vaultName';

describe('folderName', () => {
  it('两种分隔符、尾部斜杠都认', () => {
    expect(folderName('D:\\notes\\工作')).toBe('工作');
    expect(folderName('/home/a/notes/')).toBe('notes');
    expect(folderName('E:\\obsidian\\obsidian')).toBe('obsidian');
    expect(folderName('notes')).toBe('notes');
  });
});

describe('safDisplayPath', () => {
  it('把 tree URI 换成 Documents/IvyeaNote 这种人能读的', () => {
    expect(safDisplayPath('content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FIvyeaNote')).toBe(
      'Documents/IvyeaNote'
    );
    expect(safDisplayPath('content://com.android.externalstorage.documents/tree/1234-5678%3ANotes')).toBe('1234-5678/Notes');
    // 根卷（primary: 后面是空的）：给不出更好的名字就原样返回，别给个空串
    expect(safDisplayPath('content://x/tree/primary%3A')).toBe('content://x/tree/primary%3A');
    expect(safDisplayPath('not-a-tree-uri')).toBe('not-a-tree-uri');
  });
});

describe('vaultDisplayName / vaultLocationLabel', () => {
  it('绑了文件夹 = 文件夹名；内部存储 = 存的名字', () => {
    expect(vaultDisplayName({ name: '我的笔记', localPath: 'D:\\notes\\工作' })).toBe('工作');
    expect(vaultDisplayName({ name: '我的笔记', localPath: 'opfs://-1' })).toBe('我的笔记');
    expect(vaultDisplayName({ name: '我的笔记' })).toBe('我的笔记');
    expect(
      vaultDisplayName({
        name: '我的笔记',
        localPath: 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FIvyeaNote',
        localLabel: 'IvyeaNote',
      })
    ).toBe('IvyeaNote');
  });
  it('位置：磁盘原样、SAF 换算、内部存储写明', () => {
    expect(vaultLocationLabel({ localPath: 'D:\\notes' })).toBe('D:\\notes');
    expect(vaultLocationLabel({ localPath: 'opfs://3' })).toBe('应用内部存储');
    expect(
      vaultLocationLabel({ localPath: 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FIvyeaNote' })
    ).toBe('Documents/IvyeaNote');
  });
});

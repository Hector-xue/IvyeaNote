import { describe, expect, it } from 'vitest';
import { isSafPath, __testing } from './saf';

const { base64ToBytes, bytesToBase64 } = __testing;

describe('isSafPath', () => {
  it('content:// 才是 SAF 树 URI', () => {
    expect(isSafPath('content://com.android.externalstorage.documents/tree/primary%3ANotes')).toBe(true);
  });

  it('磁盘路径、OPFS 标记、空值都不是', () => {
    expect(isSafPath('/storage/emulated/0/Notes')).toBe(false);
    expect(isSafPath('D:\\Notes')).toBe(false);
    expect(isSafPath('opfs://-1')).toBe(false);
    expect(isSafPath('')).toBe(false);
    expect(isSafPath(null)).toBe(false);
    expect(isSafPath(undefined)).toBe(false);
  });
});

describe('base64 往返（二进制走 JSON 桥必须编码）', () => {
  it('空数据', () => {
    expect(base64ToBytes(bytesToBase64(new Uint8Array()))).toEqual(new Uint8Array());
  });

  it('全字节值都还原得回来（0..255 一个不漏）', () => {
    const src = new Uint8Array(256);
    for (let i = 0; i < 256; i++) src[i] = i;
    expect(base64ToBytes(bytesToBase64(src))).toEqual(src);
  });

  it('PNG 文件头这种真实二进制不被破坏', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(base64ToBytes(bytesToBase64(png))).toEqual(png);
  });

  /**
   * 分块拼接是为了避免 String.fromCharCode 一次收几十万个参数爆栈——
   * 图片附件轻松就超过这个量级，不分块就是"存个图崩一次"。
   */
  it('远超单次 apply 上限的大数据也不爆栈', () => {
    const big = new Uint8Array(300_000);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    const round = base64ToBytes(bytesToBase64(big));
    expect(round.length).toBe(big.length);
    expect(round[0]).toBe(big[0]);
    expect(round[299_999]).toBe(big[299_999]);
    expect(round).toEqual(big);
  });

  it('UTF-8 中文内容按字节还原', () => {
    const bytes = new TextEncoder().encode('中文笔记 · Ivyea');
    expect(new TextDecoder().decode(base64ToBytes(bytesToBase64(bytes)))).toBe('中文笔记 · Ivyea');
  });
});

/**
 * 回收站的命名规则。
 *
 * 起因（2026-09-08 真机）：「无法删除绑定目录的文件」。两处叠加——
 * ① 删除时的重名递增写死成 `replace(/(\.md)$/i,'-1$1')`，非 .md 文件匹配不上，
 *    `while (exists)` 原地打转；
 * ② 搬运走的是文本读写，图片/PDF 过一遍 UTF-8 解码要么抛、要么被毁。
 */
import { describe, expect, it } from 'vitest';
import { nextTrashName, originalPathOf, trashPathFor } from './useTrash';

describe('nextTrashName', () => {
  it('序号加在扩展名之前，且每次都真的往前走（否则死循环）', () => {
    const a = nextTrashName('.trash/2026-01-01T00-00-00-图.png');
    expect(a).toBe('.trash/2026-01-01T00-00-00-图-1.png');
    expect(nextTrashName(a)).toBe('.trash/2026-01-01T00-00-00-图-2.png');
    expect(nextTrashName('.trash/2026-01-01T00-00-00-a.md')).toBe(
      '.trash/2026-01-01T00-00-00-a-1.md'
    );
    // 没有扩展名也要能递增
    expect(nextTrashName('.trash/x')).toBe('.trash/x-1');
    expect(nextTrashName('.trash/x-1')).toBe('.trash/x-2');
  });

  it('连续递增 5 次不会原地不动', () => {
    let p = trashPathFor('图.png', new Date('2026-01-01T00:00:00Z'));
    const seen = new Set([p]);
    for (let i = 0; i < 5; i++) {
      p = nextTrashName(p);
      expect(seen.has(p)).toBe(false);
      seen.add(p);
    }
  });

  it('反解回原路径时目录分隔符还原得回来', () => {
    const p = trashPathFor('子目录/图.png', new Date('2026-01-01T00:00:00Z'));
    expect(originalPathOf(p)).toBe('子目录/图.png');
  });
});

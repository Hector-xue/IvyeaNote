import { describe, expect, it } from 'vitest';
import {
  deleteCol,
  deleteRow,
  emptyTable,
  insertCol,
  insertRow,
  isDividerRow,
  moveCol,
  moveRow,
  parseTable,
  scanTables,
  serializeTable,
  setAlign,
  setCellInRow,
  splitRow,
} from './tableEdit';
import { scanFences } from './livePreview';

describe('splitRow', () => {
  it('首尾竖线可有可无，格内两侧空白去掉', () => {
    expect(splitRow('| a | b |')).toEqual(['a', 'b']);
    expect(splitRow('a | b')).toEqual(['a', 'b']);
    expect(splitRow('|  |  |')).toEqual(['', '']);
  });
  it('\\| 不是分隔符，还原成竖线', () => {
    expect(splitRow('| a \\| b | c |')).toEqual(['a | b', 'c']);
  });
  it('末尾是 \\| 时不当成收尾竖线', () => {
    expect(splitRow('| a | b\\|')).toEqual(['a', 'b|']);
  });
});

describe('parseTable / serializeTable', () => {
  it('表头 + 分隔行 + 正文，对齐从分隔行读', () => {
    const m = parseTable(['| 名称 | 数量 | 备注 |', '| :--- | ---: | :---: |', '| 苹果 | 3 | 甜 |'])!;
    expect(m.header).toEqual(['名称', '数量', '备注']);
    expect(m.align).toEqual(['left', 'right', 'center']);
    expect(m.rows).toEqual([['苹果', '3', '甜']]);
  });
  it('正文行格数多了丢、少了补空（与 GFM 一致）', () => {
    const m = parseTable(['| a | b |', '| - | - |', '| 1 |', '| 1 | 2 | 3 |'])!;
    expect(m.rows).toEqual([
      ['1', ''],
      ['1', '2'],
    ]);
  });
  it('第二行不是分隔行、或格数对不上，就不是表格', () => {
    expect(parseTable(['| a | b |', '| 1 | 2 |'])).toBeNull();
    expect(parseTable(['| a | b |', '| --- |'])).toBeNull();
    expect(parseTable(['| a |'])).toBeNull();
  });
  it('序列化是 `| a | b |` 形状，竖线转义，换行压成空格', () => {
    const lines = serializeTable({ header: ['a|b', 'c'], align: [null, 'right'], rows: [['x\ny', '']] });
    expect(lines).toEqual(['| a\\|b | c |', '| --- | ---: |', '| x y |  |']);
    // 来回一致
    expect(parseTable(lines)).toEqual({ header: ['a|b', 'c'], align: [null, 'right'], rows: [['x y', '']] });
  });
  it('isDividerRow 认各种对齐写法，不认有内容的行', () => {
    expect(isDividerRow('|---|:-:|--:|')).toBe(true);
    expect(isDividerRow('| - | - |')).toBe(true);
    expect(isDividerRow('| a | - |')).toBe(false);
    expect(isDividerRow('| | |')).toBe(false);
  });
});

describe('setCellInRow：只改一格、其余格原样', () => {
  it('替换指定格并转义', () => {
    expect(setCellInRow('| a | b |', 1, 'x|y', 2)).toBe('| a | x\\|y |');
  });
  it('原行格数不足时补齐到列数', () => {
    expect(setCellInRow('| a |', 2, 'z', 3)).toBe('| a |  | z |');
  });
});

describe('scanTables', () => {
  it('从「表头 + 分隔行」开始，到空行或不含竖线的行为止', () => {
    const md = ['前言', '| a | b |', '| - | - |', '| 1 | 2 |', '| 3 | 4 |', '', '| 孤儿行 |', '正文'];
    expect(scanTables(md)).toEqual([{ start: 2, end: 5 }]);
  });
  it('两张表各算各的；正文里的一个竖线不算表', () => {
    const md = ['| a |', '| - |', 'x | y', '', '| b |', '| - |', '有 | 竖线的正文'];
    // 第 3 行 `x | y` 含竖线，按 GFM 仍是第一张表的正文行；第 7 行同理属于第二张
    expect(scanTables(md)).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 7 },
    ]);
  });
  it('代码块里的表格不算', () => {
    const md = ['```', '| a |', '| - |', '```', '| b |', '| - |'];
    expect(scanTables(md, scanFences(md))).toEqual([{ start: 5, end: 6 }]);
  });
});

describe('结构操作', () => {
  const m = parseTable(['| a | b |', '| :-- | --: |', '| 1 | 2 |', '| 3 | 4 |'])!;

  it('insertRow：在指定正文行之前插空行，越界夹到两端', () => {
    expect(insertRow(m, 1).rows).toEqual([['1', '2'], ['', ''], ['3', '4']]);
    expect(insertRow(m, 99).rows).toEqual([['1', '2'], ['3', '4'], ['', '']]);
    expect(m.rows).toHaveLength(2); // 入参没被改
  });
  it('deleteRow：删正文行；越界无事', () => {
    expect(deleteRow(m, 0).rows).toEqual([['3', '4']]);
    expect(deleteRow(m, 5).rows).toEqual(m.rows);
  });
  it('insertCol：表头 / 对齐 / 正文一起加', () => {
    const n = insertCol(m, 1);
    expect(n.header).toEqual(['a', '', 'b']);
    expect(n.align).toEqual(['left', null, 'right']);
    expect(n.rows).toEqual([['1', '', '2'], ['3', '', '4']]);
  });
  it('deleteCol：只剩一列时返回 null', () => {
    const n = deleteCol(m, 0)!;
    expect(n.header).toEqual(['b']);
    expect(n.rows).toEqual([['2'], ['4']]);
    expect(deleteCol(n, 0)).toBeNull();
  });
  it('setAlign', () => {
    expect(setAlign(m, 0, 'center').align).toEqual(['center', 'right']);
  });
  it('moveRow / moveCol：到边界不动', () => {
    expect(moveRow(m, 0, 1).rows).toEqual([['3', '4'], ['1', '2']]);
    expect(moveRow(m, 0, -1).rows).toEqual(m.rows);
    const c = moveCol(m, 0, 1);
    expect(c.header).toEqual(['b', 'a']);
    expect(c.align).toEqual(['right', 'left']);
    expect(c.rows).toEqual([['2', '1'], ['4', '3']]);
  });
  it('emptyTable：两列一行正文', () => {
    expect(emptyTable()).toEqual(['| 列 1 | 列 2 |', '| --- | --- |', '|  |  |']);
    expect(emptyTable(3, 2)).toHaveLength(4);
  });
});

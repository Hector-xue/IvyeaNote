import { describe, it, expect } from 'vitest';
import { parseTaskLine } from './livePreview';

describe('parseTaskLine', () => {
  it('解析未完成任务', () => {
    const r = parseTaskLine('- [ ] 买牛奶', 100);
    expect(r).not.toBeNull();
    expect(r!.checked).toBe(false);
    expect(r!.boxTo - r!.boxFrom).toBe(3);
    expect(r!.textFrom).toBe(100 + 6); // "- [ ] " 之后
  });
  it('解析已完成任务（大小写 x/X）', () => {
    expect(parseTaskLine('- [x] done', 0)!.checked).toBe(true);
    expect(parseTaskLine('* [X] done', 0)!.checked).toBe(true);
  });
  it('支持 + 和 * 列表符', () => {
    expect(parseTaskLine('+ [ ] a', 0)).not.toBeNull();
    expect(parseTaskLine('* [ ] a', 0)).not.toBeNull();
  });
  it('非任务行返回 null', () => {
    expect(parseTaskLine('普通文本', 0)).toBeNull();
    expect(parseTaskLine('- 普通列表项', 0)).toBeNull();
    expect(parseTaskLine('# 标题', 0)).toBeNull();
  });
  it('offset 计算正确', () => {
    const line = '  - [x] 缩进任务';
    const r = parseTaskLine(line, 50)!;
    expect(line.slice(r.boxFrom - 50, r.boxTo - 50)).toBe('[x]');
    expect(line.slice(r.textFrom - 50)).toBe('缩进任务');
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { MenuItem } from '../ui/ContextMenu';
import { menuToSheetGroups } from './menuToSheet';

describe('menuToSheetGroups（右键菜单 → 手机底部菜单）', () => {
  it('分隔线切分组，空组不产出，快捷键丢掉，hint 变小字', () => {
    const run = vi.fn();
    const items: MenuItem[] = [
      { type: 'sep', id: 's0' },
      { id: 'copy', label: '复制', icon: 'copy', shortcut: 'Ctrl+C', run },
      { id: 'paste', label: '粘贴', icon: 'paste', disabled: true, run: vi.fn() },
      { type: 'sep', id: 's1' },
      { type: 'sep', id: 's2' },
      { id: 'ai', label: '润色', hint: '会改正文', danger: true, checked: true, run: vi.fn() },
      { type: 'sep', id: 's3' },
    ];
    const groups = menuToSheetGroups(items, vi.fn());
    expect(groups.map((g) => g.map((i) => i.key))).toEqual([['copy', 'paste'], ['ai']]);
    const [copy, paste] = groups[0];
    expect(copy).toMatchObject({ label: '复制', icon: 'copy' });
    expect('shortcut' in copy).toBe(false);
    expect(paste.disabled).toBe(true);
    expect(copy.more).toBe(false);
    expect(groups[1][0]).toMatchObject({ sub: '会改正文', danger: true, checked: true });
    copy.onClick();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('带子菜单的项点下去是进下一层，不是跑动作', () => {
    const openSub = vi.fn();
    const children: MenuItem[] = [{ id: 'b', label: '加粗', run: vi.fn() }];
    const items: MenuItem[] = [{ id: 'fmt', label: '文本格式', submenu: children }];
    const [[fmt]] = menuToSheetGroups(items, openSub);
    expect(fmt.more).toBe(true);
    fmt.onClick();
    expect(openSub).toHaveBeenCalledWith(children);
  });

  it('没有 run 的普通项点了不炸', () => {
    const items: MenuItem[] = [{ id: 'x', label: '占位' }];
    expect(() => menuToSheetGroups(items, vi.fn())[0][0].onClick()).not.toThrow();
  });
});

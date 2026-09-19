/**
 * 把编辑区右键菜单的条目（桌面那份数据）换算成移动端底部弹出菜单的分组（v0.11.35）。
 *
 * 为什么要有这一层：手机上长按不再弹桌面那张右键菜单（它把系统的选词、拖拽把手、
 * 复制条一并压掉了，见 MarkdownEditor 的 openEditorMenu），但菜单里的能力——
 * 表格行列、段落设置、AI——在手机上没有第二个入口。于是菜单**是什么**仍由
 * lib/editorMenu 一份产出，这里只做数据到数据的换算，不再手写第二份菜单。
 *
 * 换算规则：
 * - 分隔线切分组（Sheet 用留白分组）；
 * - 带 submenu 的项本身保留为一项，点它 → `openSub(children)` 推进到下一层
 *   （Sheet 一屏放不下把二十几项表格操作全铺开）；
 * - `shortcut` 是键盘的事，手机上丢掉；`hint` 变成标签下那行小字。
 */
import type { MenuItem } from '../ui/ContextMenu';
import type { SheetItem } from '../ui/mobile/Sheet';
import { isSeparator } from '../ui/ContextMenu';

export function menuToSheetGroups(items: MenuItem[], openSub: (children: MenuItem[]) => void): SheetItem[][] {
  const groups: SheetItem[][] = [[]];
  for (const it of items) {
    if (isSeparator(it)) {
      if (groups[groups.length - 1].length > 0) groups.push([]);
      continue;
    }
    const children = it.submenu;
    groups[groups.length - 1].push({
      key: it.id,
      icon: it.icon,
      label: it.label,
      sub: it.hint,
      checked: it.checked,
      danger: it.danger,
      disabled: it.disabled,
      more: !!children,
      // 二级菜单：进下一层；普通项：跑它自己的动作
      onClick: children ? () => openSub(children) : () => it.run?.(),
    });
  }
  return groups.filter((g) => g.length > 0);
}

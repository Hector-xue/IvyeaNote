/**
 * 编辑区右键菜单（v0.11.0）。
 *
 * 菜单**是什么**是纯数据，所以能这么测：不需要启动 CodeMirror，也不需要真的右键。
 * 这里锁住的是几条会静默长歪的规则——没有选区时剪切/复制要置灰而不是点了没反应、
 * 只读视图里不能出现任何会改文档的项、Obsidian 的「新增链接/新增外部链接」
 * 是两件不同的事。
 */
import { describe, expect, it, vi } from 'vitest';
import { blockSnippet, buildEditorMenu, type EditorMenuActions, type EditorMenuCtx } from './editorMenu';
import { isSeparator, type MenuAction, type MenuItem } from '../ui/ContextMenu';

const actions = (): EditorMenuActions => ({
  format: vi.fn(),
  heading: vi.fn(),
  insertBlock: vi.fn(),
  insertImage: vi.fn(),
  link: vi.fn(),
  externalLink: vi.fn(),
  clearFormat: vi.fn(),
  cut: vi.fn(),
  copy: vi.fn(),
  paste: vi.fn(),
  pastePlain: vi.fn(),
  selectAll: vi.fn(),
  openLink: vi.fn(),
  copyToClipboard: vi.fn(),
});

const base: EditorMenuCtx = {
  hasSelection: false,
  linkHref: null,
  imageSrc: null,
  canInsertImage: true,
};

/** 拍平（含子菜单）后按 id 找一项 */
function find(items: MenuItem[], id: string): MenuAction | undefined {
  for (const it of items) {
    if (isSeparator(it)) continue;
    if (it.id === id) return it;
    if (it.submenu) {
      const hit = find(it.submenu, id);
      if (hit) return hit;
    }
  }
  return undefined;
}

function ids(items: MenuItem[]): string[] {
  return items.filter((i) => !isSeparator(i)).map((i) => (i as MenuAction).id);
}

describe('buildEditorMenu', () => {
  it('对齐 Obsidian 的骨架：链接 → 三个子菜单 → 剪贴板', () => {
    const m = buildEditorMenu(base, actions());
    expect(ids(m)).toEqual([
      'link',
      'ext-link',
      'text-format',
      'para',
      'insert',
      'cut',
      'copy',
      'paste',
      'paste-plain',
      'select-all',
    ]);
    expect(m.some(isSeparator)).toBe(true);
  });

  it('三个二级菜单都真的有子项', () => {
    const m = buildEditorMenu(base, actions());
    for (const id of ['text-format', 'para', 'insert']) {
      expect(find(m, id)!.submenu!.length).toBeGreaterThan(3);
    }
  });

  it('没有选区时剪切/复制/清除格式置灰（而不是消失，也不是点了没反应）', () => {
    const m = buildEditorMenu(base, actions());
    expect(find(m, 'cut')!.disabled).toBe(true);
    expect(find(m, 'copy')!.disabled).toBe(true);
    expect(find(m, 'clear')!.disabled).toBe(true);
    const withSel = buildEditorMenu({ ...base, hasSelection: true }, actions());
    expect(find(withSel, 'cut')!.disabled).toBe(false);
    expect(find(withSel, 'copy')!.disabled).toBe(false);
  });

  it('没有当前笔记时「插入图片」置灰——附件不知道该落在哪', () => {
    const m = buildEditorMenu({ ...base, canInsertImage: false }, actions());
    expect(find(m, 'image')!.disabled).toBe(true);
  });

  it('右键点在链接上时，最前面是「打开链接 / 复制链接地址」', () => {
    const act = actions();
    const m = buildEditorMenu({ ...base, linkHref: 'https://a.com' }, act);
    expect(ids(m).slice(0, 2)).toEqual(['open-link', 'copy-link']);
    find(m, 'open-link')!.run!();
    expect(act.openLink).toHaveBeenCalledWith('https://a.com');
    find(m, 'copy-link')!.run!();
    expect(act.copyToClipboard).toHaveBeenCalledWith('https://a.com');
  });

  it('右键点在图片上时能复制**库内**路径（不是 blob URL）', () => {
    const act = actions();
    const m = buildEditorMenu({ ...base, imageSrc: 'Attachments/a.png' }, act);
    find(m, 'copy-img-path')!.run!();
    expect(act.copyToClipboard).toHaveBeenCalledWith('Attachments/a.png');
  });

  it('只读视图（分栏右栏 / 阅读态）里没有任何会改文档的项', () => {
    const m = buildEditorMenu({ ...base, readOnly: true, hasSelection: true }, actions());
    expect(ids(m)).toEqual(['copy', 'select-all']);
  });

  it('「新增链接」是双链，「新增外部链接」是 Markdown 链接——两件不同的事', () => {
    const act = actions();
    const m = buildEditorMenu(base, act);
    find(m, 'link')!.run!();
    expect(act.link).toHaveBeenCalledTimes(1);
    expect(act.externalLink).not.toHaveBeenCalled();
    find(m, 'ext-link')!.run!();
    expect(act.externalLink).toHaveBeenCalledTimes(1);
  });

  it('标题 1~6 各自把级别原样传下去', () => {
    const act = actions();
    const m = buildEditorMenu(base, act);
    find(m, 'h4')!.run!();
    expect(act.heading).toHaveBeenCalledWith(4);
    find(m, 'p')!.run!();
    expect(act.heading).toHaveBeenCalledWith(0);
  });

  it('每一项要么能执行、要么是子菜单——不能两样都没有', () => {
    const walk = (items: MenuItem[]) => {
      for (const it of items) {
        if (isSeparator(it)) continue;
        expect(Boolean(it.run) || Boolean(it.submenu)).toBe(true);
        if (it.submenu) walk(it.submenu);
      }
    };
    walk(buildEditorMenu({ ...base, linkHref: 'x', imageSrc: 'y' }, actions()));
  });

  it('id 在同一层里不重名（重名会让 React key 打架、键盘定位错行）', () => {
    const check = (items: MenuItem[]) => {
      const seen = items.map((i) => i.id);
      expect(new Set(seen).size).toBe(seen.length);
      for (const it of items) if (!isSeparator(it) && it.submenu) check(it.submenu);
    };
    check(buildEditorMenu({ ...base, linkHref: 'x', imageSrc: 'y' }, actions()));
  });
});

describe('blockSnippet', () => {
  it('表格给出可用的三行，光标落在第一个表头单元格', () => {
    const t = blockSnippet('table');
    expect(t.text.split('\n').filter(Boolean)).toHaveLength(3);
    expect(t.text.slice(t.caret!, t.caret! + 3)).toBe('列 1');
  });

  it('代码块光标落在两条围栏中间那一行', () => {
    const c = blockSnippet('codeblock');
    expect(c.text.slice(0, c.caret)).toBe('```\n');
  });

  it('标注给出 Obsidian 的 callout 语法', () => {
    expect(blockSnippet('callout').text.startsWith('> [!note]')).toBe(true);
  });

  it('日期/时间按本地时间补零', () => {
    const d = new Date(2026, 8, 7, 9, 5);
    expect(blockSnippet('date', d).text).toBe('2026-09-07');
    expect(blockSnippet('time', d).text).toBe('09:05');
  });
});

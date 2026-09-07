import { describe, expect, it } from 'vitest';
import {
  clearFormatting,
  cycleHeading,
  insertBlock,
  insertText,
  insertWikiLink,
  setHeading,
  insertImage,
  insertLink,
  toggleInline,
  toggleLinePrefix,
  toggleOrderedList,
  toggleTaskList,
} from './format';

const S = (from: number, to: number) => ({ from, to });

describe('toggleInline（加粗/斜体/代码）', () => {
  it('包裹选区', () => {
    const r = toggleInline('hello world', S(6, 11), '**');
    expect(r.text).toBe('hello **world**');
    expect(r.text.slice(r.sel.from, r.sel.to)).toBe('world');
  });
  it('选区已包裹则解包', () => {
    const r = toggleInline('hello **world**', S(6, 15), '**');
    expect(r.text).toBe('hello world');
  });
  it('光标外侧紧邻 marker 也解包', () => {
    const r = toggleInline('hello **world**', S(8, 13), '**');
    expect(r.text).toBe('hello world');
  });
});

describe('toggleLinePrefix（无序列表/引用）', () => {
  it('多行加前缀', () => {
    const r = toggleLinePrefix('a\nb', S(0, 3), '- ');
    expect(r.text).toBe('- a\n- b');
  });
  it('已有前缀则去掉', () => {
    const r = toggleLinePrefix('- a\n- b', S(0, 7), '- ');
    expect(r.text).toBe('a\nb');
  });
  it('部分行有前缀 → 全部加上', () => {
    const r = toggleLinePrefix('- a\nb', S(0, 5), '- ');
    expect(r.text).toBe('- a\n- b');
  });
  it('引用块', () => {
    const r = toggleLinePrefix('quote me', S(0, 8), '> ');
    expect(r.text).toBe('> quote me');
  });
});

describe('cycleHeading（标题循环）', () => {
  it('无 → # → ## → ### → 无', () => {
    let t = 'title';
    t = cycleHeading(t, S(0, 5)).text;
    expect(t).toBe('# title');
    t = cycleHeading(t, S(0, 7)).text;
    expect(t).toBe('## title');
    t = cycleHeading(t, S(0, 8)).text;
    expect(t).toBe('### title');
    t = cycleHeading(t, S(0, 9)).text;
    expect(t).toBe('title');
  });
});

describe('toggleOrderedList / toggleTaskList', () => {
  it('有序列表编号', () => {
    const r = toggleOrderedList('a\nb', S(0, 3), );
    expect(r.text).toBe('1. a\n2. b');
  });
  it('任务列表', () => {
    const r = toggleTaskList('todo', S(0, 4));
    expect(r.text).toBe('- [ ] todo');
    const r2 = toggleTaskList(r.text, S(0, r.text.length));
    expect(r2.text).toBe('todo');
  });
});

describe('insertLink / insertImage', () => {
  it('链接：选区做文字，选中 url 占位', () => {
    const r = insertLink('see this', S(4, 8));
    expect(r.text).toBe('see [this](https://)');
    expect(r.text.slice(r.sel.from, r.sel.to)).toBe('https://');
  });
  it('图片引用', () => {
    const r = insertImage('doc', S(3, 3), 'Attachments/pic.png');
    expect(r.text).toBe('doc![pic](Attachments/pic.png)');
  });
});

/* ---------------- v0.11.0：右键菜单用到的新命令 ---------------- */

describe('setHeading', () => {
  it('指定级别，而不是循环——菜单里点「标题 3」就该是 3', () => {
    const r = setHeading('正文', S(0, 0), 3);
    expect(r.text).toBe('### 正文');
  });
  it('已有标题会被替换而不是叠加', () => {
    expect(setHeading('## 旧', S(0, 0), 1).text).toBe('# 旧');
    expect(setHeading('###### 六级', S(0, 0), 2).text).toBe('## 六级');
  });
  it('级别 0 = 恢复正文', () => {
    expect(setHeading('### 标题', S(0, 0), 0).text).toBe('标题');
  });
  it('多行选区整块处理', () => {
    const t = 'a\nb';
    expect(setHeading(t, S(0, 3), 2).text).toBe('## a\n## b');
  });
});

describe('insertBlock', () => {
  it('不在行首时先补一个换行——否则表格会被当成正文里的竖线', () => {
    const r = insertBlock('前面有字', S(4, 4), '---\n');
    expect(r.text).toBe('前面有字\n---\n');
  });
  it('已经在行首就不多加空行', () => {
    const r = insertBlock('', S(0, 0), '---\n');
    expect(r.text).toBe('---\n');
  });
  it('caretOffset 让光标落在块内的占位处', () => {
    const r = insertBlock('', S(0, 0), '```\n\n```\n', 4);
    expect(r.sel).toEqual({ from: 4, to: 4 });
  });
});

describe('insertText', () => {
  it('替换选区并把光标放到末尾', () => {
    const r = insertText('abcd', S(1, 3), 'X');
    expect(r.text).toBe('aXd');
    expect(r.sel).toEqual({ from: 2, to: 2 });
  });
});

describe('insertWikiLink', () => {
  it('空选区插入 [[]]，光标落在中间', () => {
    const r = insertWikiLink('', S(0, 0));
    expect(r.text).toBe('[[]]');
    expect(r.sel).toEqual({ from: 2, to: 2 });
  });
  it('有选区时选中的文字成为链接目标并保持被选中', () => {
    const r = insertWikiLink('见笔记甲', S(1, 4));
    expect(r.text).toBe('见[[笔记甲]]');
    expect(r.text.slice(r.sel.from, r.sel.to)).toBe('笔记甲');
  });
});

describe('clearFormatting', () => {
  it('脱掉行内标记，保留文字', () => {
    const t = '**粗**和*斜*和`码`和~~删~~和==亮==';
    const r = clearFormatting(t, S(0, t.length));
    expect(r.text).toBe('粗和斜和码和删和亮');
  });
  it('链接只留文字，图片只留 alt', () => {
    const t = '[标题](https://a.com) 与 ![图](a.png)';
    expect(clearFormatting(t, S(0, t.length)).text).toBe('标题 与 图');
  });
  it('脱掉行首的块标记', () => {
    const t = '### 标题\n- [ ] 待办\n> 引用';
    expect(clearFormatting(t, S(0, t.length)).text).toBe('标题\n待办\n引用');
  });
  it('没有选区就什么都不做', () => {
    expect(clearFormatting('**粗**', S(0, 0)).text).toBe('**粗**');
  });
});

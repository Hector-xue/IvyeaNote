import { describe, expect, it } from 'vitest';
import {
  cycleHeading,
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

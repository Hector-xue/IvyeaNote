// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  hasScripts,
  isStoragePath,
  parseStorageFile,
  serializeStorageFile,
  storagePathFor,
  storageShim,
} from './htmlSandbox';

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

describe('数据文件', () => {
  it('路径紧挨着 HTML', () => {
    expect(storagePathFor('工具/a.html')).toBe('工具/a.html.data.json');
    expect(isStoragePath('工具/a.html.data.json')).toBe(true);
    expect(isStoragePath('工具/a.htm.data.json')).toBe(true);
    expect(isStoragePath('工具/a.json')).toBe(false);
  });
  it('读写往返；坏 JSON / 非字符串值 / 老格式都不炸', () => {
    const text = serializeStorageFile({ a: '1', b: '{"x":1}' });
    expect(parseStorageFile(text)).toEqual({ a: '1', b: '{"x":1}' });
    expect(parseStorageFile(null)).toEqual({});
    expect(parseStorageFile('{not json')).toEqual({});
    expect(parseStorageFile('{"local":{"a":"1","n":2}}')).toEqual({ a: '1' });
    expect(parseStorageFile('{"a":"plain"}')).toEqual({ a: 'plain' });
    expect(parseStorageFile('[1,2]')).toEqual({});
  });
});

describe('hasScripts', () => {
  it('<script> / 内联处理器 / javascript: 都算', () => {
    expect(hasScripts(parse('<p>hi</p>'))).toBe(false);
    expect(hasScripts(parse('<script>1</script>'))).toBe(true);
    expect(hasScripts(parse('<button onclick="x()">a</button>'))).toBe(true);
    expect(hasScripts(parse('<a href="javascript:void 0">a</a>'))).toBe(true);
    expect(hasScripts(parse('<a href="https://x">a</a><style>a{}</style>'))).toBe(false);
  });
});

describe('storageShim', () => {
  it('初始数据内嵌且 </script> 被转义，不会提前闭合标签', () => {
    const js = storageShim({ k: '</script><script>alert(1)</script>' });
    expect(js).not.toContain('</script>');
    expect(js).toContain('\\u003c/script>');
  });
  it('是能执行的 JS，且在没有 window.localStorage 的环境里也能装上去', () => {
    // 在一个干净的全局对象上跑：模拟"不透明来源里 localStorage 不可用"
    const win: Record<string, unknown> = {};
    const doc = function Doc() {} as unknown as { prototype: object };
    const parentMsgs: unknown[] = [];
    const fn = new Function('window', 'Document', 'parent', storageShim({ seed: '1' }));
    fn(win, doc, { postMessage: (m: unknown) => parentMsgs.push(m) });
    const ls = win.localStorage as Storage & Record<string, string>;
    expect(ls.getItem('seed')).toBe('1');
    ls.setItem('a', '2');
    ls.b = '3';
    expect(ls.length).toBe(3);
    expect(Object.keys(ls)).toEqual(['seed', 'a', 'b']);
    expect(JSON.parse(JSON.stringify(ls))).toEqual({ seed: '1', a: '2', b: '3' });
    ls.removeItem('a');
    expect(ls.getItem('a')).toBeNull();
    ls.clear();
    expect(ls.length).toBe(0);
    // 每次写都通知外层；最后一次是 clear 之后的空对象
    expect(parentMsgs.length).toBe(4);
    expect(parentMsgs[3]).toEqual({ type: 'ivnote-storage', name: 'local', data: {} });
  });
});

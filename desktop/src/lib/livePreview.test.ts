import { describe, it, expect } from 'vitest';
import {
  findBareUrls,
  findInlineLinks,
  findFootnoteRefs,
  isHorizontalRule,
  isTableDivider,
  isTableRow,
  parseCallout,
  parseFootnoteDef,
  parseTaskLine,
} from './livePreview';

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

/* ---- v0.8.5 E4：方案点名要扩的四类 ---- */

describe('分隔线', () => {
  it('三种写法都认', () => {
    expect(isHorizontalRule('---')).toBe(true);
    expect(isHorizontalRule('***')).toBe(true);
    expect(isHorizontalRule('___')).toBe(true);
  });
  it('更长的也认，前后空白无所谓', () => {
    expect(isHorizontalRule('  ------  ')).toBe(true);
  });
  it('不足三个不算', () => {
    expect(isHorizontalRule('--')).toBe(false);
  });
  it('带正文的不算——「--- 说明」不是分隔线', () => {
    expect(isHorizontalRule('--- 说明')).toBe(false);
  });
  it('列表项 `- 买牛奶` 不能被当成分隔线', () => {
    expect(isHorizontalRule('- 买牛奶')).toBe(false);
  });
});

describe('表格', () => {
  it('两端有竖线的是表格行', () => {
    expect(isTableRow('| 站点 | 广告费 |')).toBe(true);
  });
  it('正文里出现一个竖线不算表格', () => {
    expect(isTableRow('管道 a | b 只是普通句子')).toBe(false);
  });
  it('分隔行识别（含对齐冒号）', () => {
    expect(isTableDivider('|---|:--:|---:|')).toBe(true);
    expect(isTableDivider('| --- | --- |')).toBe(true);
  });
  it('有内容的表格行不是分隔行', () => {
    expect(isTableDivider('| 站点 | 广告费 |')).toBe(false);
  });
  it('全是竖线没有横线的不算分隔行', () => {
    expect(isTableDivider('|   |   |')).toBe(false);
  });
});

describe('callout', () => {
  it('解析类型并给出标记区间', () => {
    const r = parseCallout('> [!warning] 注意');
    expect(r).not.toBeNull();
    expect(r!.type).toBe('warning');
    // 标记结束后就是标题文字
    expect('> [!warning] 注意'.slice(r!.markEnd)).toBe('注意');
  });
  it('类型大小写归一', () => {
    expect(parseCallout('> [!NOTE] x')!.type).toBe('note');
  });
  it('普通引用不是 callout', () => {
    expect(parseCallout('> 只是引用')).toBeNull();
  });
  it('不带 > 的方括号不是 callout', () => {
    expect(parseCallout('[!note] 这不是引用')).toBeNull();
  });
});

describe('脚注', () => {
  it('定义行给出标记长度', () => {
    const r = parseFootnoteDef('[^1]: 数据来自领星');
    expect(r!.label).toBe('1');
    expect('[^1]: 数据来自领星'.slice(r!.markEnd)).toBe('数据来自领星');
  });
  it('行内引用能找全', () => {
    expect(findFootnoteRefs('见脚注[^1]与[^note]。')).toHaveLength(2);
  });
  it('定义行开头的 [^1]: 不该被当成行内引用', () => {
    expect(findFootnoteRefs('[^1]: 定义')).toHaveLength(0);
  });
  it('普通链接不是脚注', () => {
    expect(findFootnoteRefs('[标题](https://x)')).toHaveLength(0);
  });
});

describe('findInlineLinks（v0.10.2 编辑态可点链接）', () => {
  it('抓出普通行内链接的文字段与地址', () => {
    const [hit] = findInlineLinks('见 [文档](https://a.com/b) 一节');
    expect(hit).toMatchObject({ href: 'https://a.com/b' });
    expect('见 [文档](https://a.com/b) 一节'.slice(hit.textFrom, hit.textTo)).toBe('文档');
  });

  it('图片 ![alt](src) 不算链接（点它应该看图，不是跳走）', () => {
    expect(findInlineLinks('![图](a.png)')).toEqual([]);
  });

  it('[[双链]] 不被内层匹配吃掉（双链有自己的跳转）', () => {
    expect(findInlineLinks('[[某笔记]](x)')).toEqual([]);
  });

  it('一行多个链接都抓到', () => {
    expect(findInlineLinks('[a](1.md) 和 [b](2.md)').map((l) => l.href)).toEqual(['1.md', '2.md']);
  });

  it('带 title 的写法也认', () => {
    expect(findInlineLinks('[a](https://x.com "标题")')[0].href).toBe('https://x.com');
  });
});

describe('findBareUrls（v0.10.2）', () => {
  it('抓出裸 URL', () => {
    expect(findBareUrls('见 https://a.com/b 处').map((u) => u.href)).toEqual(['https://a.com/b']);
  });

  it('结尾中文句号不算地址的一部分', () => {
    expect(findBareUrls('见 https://a.com/b。').map((u) => u.href)).toEqual(['https://a.com/b']);
  });

  it('多出来的右括号剔掉，成对的保留', () => {
    expect(findBareUrls('(见 https://a.com/b)').map((u) => u.href)).toEqual(['https://a.com/b']);
    expect(findBareUrls('见 https://a.com/x_(y) 处').map((u) => u.href)).toEqual([
      'https://a.com/x_(y)',
    ]);
  });

  it('Markdown 链接括号里的地址不重复抓（那边已有装饰）', () => {
    expect(findBareUrls('[a](https://a.com)')).toEqual([]);
  });
});

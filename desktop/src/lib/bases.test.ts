import { describe, it, expect } from 'vitest';
import { compileExpr, parseBase, parseFrontmatter, runBase, buildCtx, type BaseNote } from './bases';

const notes: BaseNote[] = [
  {
    path: '个人提升/FDE面试准备.md',
    content: '---\nstatus: doing\npriority: 2\ntags: [面试, AI]\n---\n\n# FDE\n见 [[技术面试版项目说明]]\n',
    mtime: 1_700_000_000_000,
    size: 120,
  },
  {
    path: '个人提升/技术面试版项目说明.md',
    content: '---\nstatus: done\npriority: 1\n---\n\n正文 #亚马逊\n',
    mtime: 1_700_000_100_000,
    size: 80,
  },
  {
    path: '简历/薛海涛.md',
    content: '没有 frontmatter 的一篇\n',
    mtime: 1_700_000_200_000,
    size: 40,
  },
];

describe('parseFrontmatter', () => {
  it('读出 frontmatter；没有就是空对象', () => {
    expect(parseFrontmatter('---\na: 1\nb: x\n---\n正文')).toEqual({ a: 1, b: 'x' });
    expect(parseFrontmatter('正文')).toEqual({});
  });

  it('frontmatter 写坏了不抛异常——一篇坏笔记不该让整张表打不开', () => {
    expect(parseFrontmatter('---\na: [1,\n---\n正文')).toEqual({});
  });
});

describe('buildCtx', () => {
  it('文件属性按 Obsidian 口径：name 不含扩展名，folder 是所在目录', () => {
    const c = buildCtx(notes[0]);
    expect(c.file.name).toBe('FDE面试准备');
    expect(c.file.ext).toBe('md');
    expect(c.file.folder).toBe('个人提升');
    expect(c.file.tags).toEqual(expect.arrayContaining(['面试', 'AI']));
    expect(c.file.links).toEqual(['技术面试版项目说明']);
  });
});

describe('compileExpr', () => {
  const ctx = buildCtx(notes[0]);

  it('比较运算符', () => {
    expect(compileExpr('status == "doing"')!(ctx)).toBe(true);
    expect(compileExpr('status != "done"')!(ctx)).toBe(true);
    expect(compileExpr('priority > 1')!(ctx)).toBe(true);
    expect(compileExpr('priority <= 1')!(ctx)).toBe(false);
  });

  it('file.* 方法', () => {
    expect(compileExpr('file.hasTag("面试")')!(ctx)).toBe(true);
    expect(compileExpr('file.hasTag("不存在")')!(ctx)).toBe(false);
    expect(compileExpr('file.inFolder("个人提升")')!(ctx)).toBe(true);
    expect(compileExpr('file.hasLink("技术面试版项目说明")')!(ctx)).toBe(true);
    expect(compileExpr('file.hasProperty("status")')!(ctx)).toBe(true);
  });

  it('属性名是中文也要认（这个库里「状态」比 status 常见）', () => {
    const zh = buildCtx({ path: 'a.md', content: '---\n状态: 在做\n---\n' });
    expect(compileExpr('状态 == "在做"')!(zh)).toBe(true);
    expect(compileExpr('状态 != "已完成"')!(zh)).toBe(true);
    expect(compileExpr('状态.contains("在")')!(zh)).toBe(true);
  });

  it('取反与真值判断', () => {
    expect(compileExpr('!file.hasTag("不存在")')!(ctx)).toBe(true);
    expect(compileExpr('status')!(ctx)).toBe(true);
    expect(compileExpr('不存在的属性')!(ctx)).toBe(false);
  });

  it('字符串方法', () => {
    expect(compileExpr('file.name.startsWith("FDE")')!(ctx)).toBe(true);
    expect(compileExpr('file.name.contains("面试")')!(ctx)).toBe(true);
    expect(compileExpr('status.isEmpty()')!(ctx)).toBe(false);
  });

  it('看不懂的表达式返回 null，而不是瞎猜一个结果', () => {
    expect(compileExpr('date(file.mtime) > date("2026-01-01")')).toBeNull();
    expect(compileExpr('formula.ppu > 3')).toBeNull();
  });
});

describe('parseBase + runBase', () => {
  const yaml = `
filters:
  and:
    - file.inFolder("个人提升")
properties:
  status:
    displayName: 状态
views:
  - type: table
    name: 我的表
    order:
      - file.name
      - status
    sort:
      - property: file.name
        direction: ASC
`;

  it('顶层 filters 与视图列都生效', () => {
    const spec = parseBase(yaml);
    expect(spec.views).toHaveLength(1);
    const r = runBase(spec, spec.views[0], notes);
    // 顶层 filters 把「简历/」那篇挡在外面
    expect(r.rows.map((x) => x.path).sort()).toEqual([
      '个人提升/FDE面试准备.md',
      '个人提升/技术面试版项目说明.md',
    ]);
    expect(r.columns.map((c) => c.label)).toEqual(['名称', '状态']);
    // displayName 覆盖列名；单元格取的是 frontmatter 里的值
    expect(r.rows.find((x) => x.path.includes('FDE'))!.cells['status']).toBe('doing');

    // 排序方向真的会反过来（按本地化排序规则，不预设中英文谁在前）
    const desc = runBase(
      spec,
      { ...spec.views[0], sort: [{ property: 'file.name', direction: 'DESC' }] },
      notes
    );
    expect(desc.rows.map((x) => x.path)).toEqual([...r.rows.map((x) => x.path)].reverse());
  });

  it('视图自己的 filters 与顶层是"与"的关系；limit 生效', () => {
    const spec = parseBase(`
views:
  - type: table
    limit: 1
    filters:
      or:
        - status == "done"
        - status == "doing"
    order: [file.name]
`);
    const r = runBase(spec, spec.views[0], notes);
    expect(r.rows).toHaveLength(1);
  });

  it('not 分支', () => {
    const spec = parseBase(`
views:
  - type: table
    filters:
      not:
        - file.inFolder("个人提升")
    order: [file.path]
`);
    const r = runBase(spec, spec.views[0], notes);
    expect(r.rows.map((x) => x.path)).toEqual(['简历/薛海涛.md']);
  });

  it('看不懂的过滤条件被记进 skipped，而不是静默丢掉', () => {
    const spec = parseBase(`
views:
  - type: table
    filters:
      and:
        - file.hasTag("面试")
        - price.toFixed(2) > 3
`);
    const r = runBase(spec, spec.views[0], notes);
    expect(r.skipped).toEqual(['price.toFixed(2) > 3']);
    expect(r.rows).toHaveLength(1); // 认得的那条照样生效
  });

  it('一个 view 都没写也要能看：默认给一张按文件名排的表', () => {
    const spec = parseBase('filters:\n  and:\n    - file.hasTag("亚马逊")\n');
    expect(spec.views[0].type).toBe('table');
    const r = runBase(spec, spec.views[0], notes);
    expect(r.rows.map((x) => x.path)).toEqual(['个人提升/技术面试版项目说明.md']);
  });

  it('groupBy 把行分到组里', () => {
    const spec = parseBase(`
views:
  - type: table
    groupBy:
      property: status
    order: [file.name]
`);
    const r = runBase(spec, spec.views[0], notes);
    expect(new Set(r.rows.map((x) => x.group))).toEqual(new Set(['doing', 'done', '（空）']));
  });

  it('不是合法 YAML 就明确报错，不是白屏', () => {
    expect(() => parseBase('views:\n  - type: [table\n')).toThrow(/YAML/);
  });
});

import { describe, expect, it } from 'vitest';
import { buildRecapSource, pickRecent, startOfDay, startOfWeek } from './recap';

const day = 24 * 3600 * 1000;
const now = new Date(2026, 8, 9, 22, 30); // 2026-09-09 22:30 本地时间

const entries = [
  { path: '商业/定价.md', mtime: now.getTime() - 3600 * 1000, content: '# 定价\n\n今天把三档订阅定下来了。' },
  { path: '技术/索引.md', mtime: now.getTime() - 5 * 3600 * 1000, content: '# 索引\n\n把全库扫描换成倒排。' },
  { path: '日记/2026-09-09.md', mtime: now.getTime() - 600 * 1000, content: '# 2026-09-09\n\n今天……' },
  { path: '旧/去年.md', mtime: now.getTime() - 200 * day, content: '陈年旧账' },
];

describe('pickRecent', () => {
  it('只要这段时间里动过的，按新到旧', () => {
    const got = pickRecent(entries, { since: startOfDay(now) });
    expect(got.map((p) => p.path)).toEqual(['商业/定价.md', '技术/索引.md']);
  });

  /* 不排除日记，今天的日记就会被拿去总结今天的日记，越滚越长 */
  it('日记本身不进材料', () => {
    const got = pickRecent(entries, { since: startOfDay(now) });
    expect(got.some((p) => p.path.startsWith('日记/'))).toBe(false);
  });

  it('一周口径能把五天前的也捞进来', () => {
    const older = [{ path: 'a.md', mtime: now.getTime() - 5 * day, content: '五天前写的' }];
    expect(pickRecent(older, { since: startOfDay(now) })).toEqual([]);
    expect(pickRecent(older, { since: startOfWeek(now) })).toHaveLength(1);
  });

  it('frontmatter 不算"写了什么"，会被剥掉', () => {
    const got = pickRecent([{ path: 'a.md', mtime: now.getTime(), content: '---\ntags: [x]\n---\n\n正文在这' }], {
      since: startOfDay(now),
    });
    expect(got[0].text).toBe('正文在这');
  });

  it('空文件不占位置', () => {
    const got = pickRecent([{ path: 'a.md', mtime: now.getTime(), content: '   \n\n' }], { since: startOfDay(now) });
    expect(got).toEqual([]);
  });

  it('篇数与总字数都封顶——一次请求的成本必须可预期', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      path: `n/${i}.md`,
      mtime: now.getTime() - i * 1000,
      content: '正'.repeat(5000),
    }));
    const got = pickRecent(many, { since: startOfDay(now), maxDocs: 5, maxCharsPerDoc: 300, maxTotalChars: 1000 });
    expect(got.length).toBeLessThanOrEqual(5);
    expect(got.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(1000 + 5); // 省略号
  });

  it('拼出来的材料每段都带路径（总结里要说得出是哪几篇）', () => {
    const src = buildRecapSource(pickRecent(entries, { since: startOfDay(now) }));
    expect(src).toContain('【商业/定价.md】');
    expect(src).toContain('【技术/索引.md】');
  });
});

describe('时间口径', () => {
  it('"今天"是本地零点起算，不是 24 小时前', () => {
    expect(new Date(startOfDay(now)).getHours()).toBe(0);
    expect(new Date(startOfDay(now)).getDate()).toBe(9);
  });
  it('"这周"含今天在内的七天', () => {
    expect(startOfDay(now) - startOfWeek(now)).toBe(6 * day);
  });
});

import { describe, expect, it } from 'vitest';
import { buildShortcuts, isActionFresh, ACTION_MAX_AGE_MS, launcherAvailable } from './launcher';

const titleOf = (p: string) => p.split('/').pop()!.replace(/\.md$/i, '');

describe('buildShortcuts', () => {
  it('固定两条 + 最近两篇（只算还在库里的 Markdown）', () => {
    const got = buildShortcuts(-1, ['a.md', 'gone.md', 'x.pdf', 'dir/b.md', 'c.md'], ['a.md', 'dir/b.md', 'c.md', 'x.pdf'], titleOf);
    expect(got.map((s) => s.kind)).toEqual(['new', 'daily', 'open', 'open']);
    expect(got[2]).toEqual({ kind: 'open', label: 'a', vaultId: -1, path: 'a.md' });
    expect(got[3]).toEqual({ kind: 'open', label: 'b', vaultId: -1, path: 'dir/b.md' });
  });

  it('没有最近记录时只有固定两条', () => {
    expect(buildShortcuts(3, [], ['a.md'], titleOf)).toHaveLength(2);
  });
});

describe('isActionFresh', () => {
  it('两分钟内算新鲜，超过就丢', () => {
    const now = 1_000_000_000;
    expect(isActionFresh({ kind: 'new', vaultId: 0, path: '', at: now - 1000 }, now)).toBe(true);
    expect(isActionFresh({ kind: 'new', vaultId: 0, path: '', at: now - ACTION_MAX_AGE_MS - 1 }, now)).toBe(false);
  });
});

describe('launcherAvailable', () => {
  it('jsdom（非 Tauri）下为 false，桌面端永远不会调原生', () => {
    expect(launcherAvailable()).toBe(false);
  });
});

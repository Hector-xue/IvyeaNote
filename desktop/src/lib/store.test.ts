import { beforeEach, describe, expect, it, vi } from 'vitest';

// store.ts 依赖 localStorage，node 环境下打桩
const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});

import {
  clearAccount,
  ensureLocalVault,
  mergeLocalIntoCloud,
  LOCAL_VAULT_ID,
  LOCAL_VAULT_NAME,
  newVaultMeta,
  type PersistState,
} from './store';

describe('免登录本地模式（v0.3.1）', () => {
  beforeEach(() => mem.clear());

  it('ensureLocalVault：空状态补建「我的笔记」本地库', () => {
    const s = ensureLocalVault({ vaults: {} });
    const v = s.vaults[String(LOCAL_VAULT_ID)];
    expect(v).toBeTruthy();
    expect(v!.name).toBe(LOCAL_VAULT_NAME);
    expect(v!.localPath).toBe('opfs://local');
  });

  it('ensureLocalVault：已存在时不覆盖同步进度（幂等）', () => {
    const cur: PersistState = {
      vaults: {
        '-1': { ...newVaultMeta(LOCAL_VAULT_ID, LOCAL_VAULT_NAME), cursor: 42, versions: { 'a.md': 3 } },
      },
    };
    const s = ensureLocalVault(cur);
    expect(s.vaults['-1'].cursor).toBe(42);
    expect(s.vaults['-1'].versions['a.md']).toBe(3);
  });

  it('clearAccount：只清账号，保留 vault 数据', () => {
    localStorage.setItem(
      'ivnote.desktop.state.v1',
      JSON.stringify({
        account: {
          serverUrl: 'https://x',
          email: 'a@b.c',
          userId: 1,
          deviceId: 'd',
          tokens: { access: 'a', refresh: 'r' },
        },
        vaults: { '-1': newVaultMeta(-1, '我的笔记'), '5': newVaultMeta(5, '云') },
      })
    );
    clearAccount();
    const s = JSON.parse(localStorage.getItem('ivnote.desktop.state.v1')!);
    expect(s.account).toBeUndefined();
    expect(Object.keys(s.vaults).length).toBe(2);
  });

  it('mergeLocalIntoCloud：保留云端进度并叠加本地游标/版本/墓碑', () => {
    const local = {
      ...newVaultMeta(-1, '我的笔记'),
      cursor: 7,
      versions: { '新.md': 1 },
      bases: { '新.md': 'x' },
      tombstones: { '删.md': 4 },
    };
    const cloud = { ...newVaultMeta(5, '云'), cursor: 9, versions: { '旧.md': 7 }, bases: { '旧.md': 'old' } };
    const m = mergeLocalIntoCloud(local, cloud);
    expect(m.cursor).toBe(9);
    expect(m.versions['旧.md']).toBe(7);
    expect(m.versions['新.md']).toBe(1);
    expect(m.tombstones?.['删.md']).toBe(4);
  });
});

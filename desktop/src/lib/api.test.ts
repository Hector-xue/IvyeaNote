/**
 * `apiBase` —— 服务器地址补全。
 *
 * 这条曾经是个从 v0.2.0 潜伏至今的 P0：构造函数硬性要求地址以 `/api/v1` 结尾，
 * 而安装脚本、登录框占位符、`probeServer` 全是裸地址口径，于是任何按文档
 * 填地址的用户，登录成功之后应用立刻被 ErrorBoundary 接住变成错误页。
 *
 * 单测没抓住它是因为同步那 17 条一致性用例都拿已经正确的 baseUrl 直接构造
 * client，绕开了登录那一段。所以这里除了正常用例，特意钉住「裸地址必须能用」。
 */
import { describe, expect, it } from 'vitest';
import { apiBase, SyncClient } from './api';

describe('apiBase', () => {
  it('裸地址补上 /api/v1 —— 安装脚本和登录框教用户填的就是这个', () => {
    expect(apiBase('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080/api/v1');
    expect(apiBase('https://note.example.com')).toBe('https://note.example.com/api/v1');
  });

  it('已经带 /api/v1 的不会补第二遍（老配置照样能用）', () => {
    expect(apiBase('https://note.example.com/api/v1')).toBe('https://note.example.com/api/v1');
  });

  it('结尾斜杠不影响结果', () => {
    expect(apiBase('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080/api/v1');
    expect(apiBase('https://x.com/api/v1/')).toBe('https://x.com/api/v1');
    expect(apiBase('http://127.0.0.1:8080///')).toBe('http://127.0.0.1:8080/api/v1');
  });

  it('前后空白被忽略——复制粘贴很容易带上', () => {
    expect(apiBase('  http://127.0.0.1:8080  ')).toBe('http://127.0.0.1:8080/api/v1');
  });

  it('带子路径的反代也照样补在最后', () => {
    expect(apiBase('https://x.com/note')).toBe('https://x.com/note/api/v1');
  });

  it('幂等：补过一次再补不会变', () => {
    const once = apiBase('http://127.0.0.1:8080');
    expect(apiBase(once)).toBe(once);
  });
});

/**
 * blob 的 401 自愈（v0.11.11）。
 *
 * access token 只有 15 分钟。`req` 一直有「401 → refresh → 重试一次」，而
 * `getBlob` / `putBlob` 直接走 `raw`，绕开了它——应用开着放一会儿，笔记正文照常，
 * 附件一律 401，而且永远不会自己好。用户看到的就是那条红条：
 * 「.ivyea/cache/content.json 上传失败：上传附件失败 HTTP 401」。
 */
describe('SyncClient blob 的登录态自愈', () => {
  function fakeFetch(script: { status: number; body?: unknown }[]) {
    const calls: { url: string; auth: string | null }[] = [];
    const fn = async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(url), auth: headers.get('Authorization') });
      const step = script.shift() ?? { status: 200 };
      return {
        ok: step.status >= 200 && step.status < 300,
        status: step.status,
        json: async () => step.body ?? {},
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      } as unknown as Response;
    };
    return { fn, calls };
  }

  it('putBlob 撞 401 会刷新登录态并重试一次', async () => {
    const { fn, calls } = fakeFetch([
      { status: 401 },
      { status: 200, body: { access_token: 'new-a', refresh_token: 'new-r' } }, // refresh
      { status: 201 },
    ]);
    const orig = globalThis.fetch;
    globalThis.fetch = fn as unknown as typeof fetch;
    try {
      let rotated: { access: string; refresh: string } | null = null;
      const c = new SyncClient('http://x', { access: 'old', refresh: 'r' }, (t) => (rotated = t), 'dev');
      await c.putBlob(new Uint8Array([1, 2, 3]));
      expect(calls[1].url).toMatch(/\/auth\/refresh$/);
      expect(calls).toHaveLength(3);
      expect(calls[2].auth).toBe('Bearer new-a');
      expect(rotated).not.toBeNull();
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('getBlob 撞 401 同样自愈', async () => {
    const { fn, calls } = fakeFetch([
      { status: 401 },
      { status: 200, body: { access_token: 'new-a', refresh_token: 'new-r' } },
      { status: 200 },
    ]);
    const orig = globalThis.fetch;
    globalThis.fetch = fn as unknown as typeof fetch;
    try {
      const c = new SyncClient('http://x', { access: 'old', refresh: 'r' }, () => undefined, 'dev');
      const buf = await c.getBlob('abc');
      expect(new Uint8Array(buf)).toEqual(new Uint8Array([1, 2, 3]));
      expect(calls).toHaveLength(3);
      expect(calls[2].auth).toBe('Bearer new-a');
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('刷新之后还是 401 就老实报错，不无限重试', async () => {
    const { fn, calls } = fakeFetch([
      { status: 401 },
      { status: 200, body: { access_token: 'new-a', refresh_token: 'new-r' } },
      { status: 401 },
    ]);
    const orig = globalThis.fetch;
    globalThis.fetch = fn as unknown as typeof fetch;
    try {
      const c = new SyncClient('http://x', { access: 'old', refresh: 'r' }, () => undefined, 'dev');
      await expect(c.getBlob('abc')).rejects.toThrow(/401/);
      expect(calls).toHaveLength(3);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

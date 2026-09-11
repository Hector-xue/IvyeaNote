// Ivyea Note 同步协议 v1 客户端（契约见 shared/protocol.md）。
// 只依赖 fetch/WebSocket，浏览器与 Tauri 通用。

import type { Tokens } from './store';
import { FETCH_FAIL_HINT } from './serverConn';

export interface LoginResult {
  access_token: string;
  refresh_token: string;
  user_id: number;
}

export interface PushChange {
  client_change_id: string;
  path: string;
  op: 'upsert' | 'delete';
  blob_hash?: string;
  base_version: number;
}

export interface PushResult {
  client_change_id: string;
  status: 'accepted' | 'conflict' | 'rejected';
  version?: number;
  server_version?: number;
  server_blob_hash?: string;
  reason?: string;
}

export interface ServerChange {
  seq: number;
  path: string;
  op: 'upsert' | 'delete';
  blob_hash?: string;
  version: number;
  device_id: string;
}

/** 某路径在云端的一个历史版本（v0.11.24 文件历史） */
export interface HistoryVersion {
  version: number;
  op: 'upsert' | 'delete';
  blob_hash?: string;
  size: number;
  device_id: string;
  /** RFC3339 UTC */
  created_at: string;
}

/** 云端当前已删除的文件（v0.11.24）；blob_hash 指向删除前最后一版 */
export interface DeletedFile {
  path: string;
  version: number;
  blob_hash: string;
  size: number;
  deleted_at: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function uuid(): string {
  return crypto.randomUUID();
}

/** 同步客户端：自动携带 token、401 时用 refresh 轮换重试一次 */
/** 一张长期令牌的元信息。列表里没有明文，只有前 8 位哈希 */
export interface McpTokenInfo {
  id: number;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at?: string;
}

/**
 * 服务器地址 → API 根。
 *
 * **这里曾经是个 P0**：构造函数原来硬性要求传进来的地址以 `/api/v1` 结尾，
 * 否则直接 throw；而 `SyncClient.login()` 收的是**裸地址**（自己拼 `/api/v1`），
 * 安装脚本、登录框占位符、`probeServer` 也全都是裸地址口径。
 * 于是「登录同步」走到 App 顶层那个 `new SyncClient(acc.serverUrl)` 就抛，
 * 整个应用被 ErrorBoundary 接住变成错误页——**从 v0.2.0 起就这样**。
 *
 * 单测没抓住它，是因为那 17 条同步一致性用例都是拿已经正确的 baseUrl 直接
 * 构造 client 跑的，绕开了登录这一段（方案 §8「测试三层」说的正是这种漏网）。
 *
 * 现在统一成一个口径：**到处都传裸地址**，补全由这里负责。
 * 已经存成带 `/api/v1` 的老配置也照样能用，不会补第二遍。
 */
export function apiBase(serverUrl: string): string {
  const u = serverUrl.trim().replace(/\/+$/, '');
  return u.endsWith('/api/v1') ? u : `${u}/api/v1`;
}

export class SyncClient {
  private refreshing?: Promise<void>;

  private baseUrl: string;

  constructor(
    serverUrl: string,
    private tokens: Tokens,
    private onTokensRotated: (t: Tokens) => void,
    private deviceId = ''
  ) {
    this.baseUrl = apiBase(serverUrl);
  }

  // ---------- 底层请求 ----------

  private raw(path: string, init: RequestInit = {}, auth = true): Promise<Response> {
    const headers = new Headers(init.headers);
    if (auth) headers.set('Authorization', `Bearer ${this.tokens.access}`);
    if (this.deviceId) headers.set('X-Device-Id', this.deviceId);
    return fetch(this.baseUrl + path, { ...init, headers });
  }

  /** 带 401 自动 refresh 重试一次的 JSON 请求 */
  /** v0.6.1 H6: generate one-time pairing code (60s) */
  createPairCode(): Promise<{ code: string; expires_in: number }> {
    return this.req<{ code: string; expires_in: number }>('/pairing/create', { method: 'POST' });
  }

  private async req<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
    let res: Response;
    try {
      res = await this.raw(path, init);
    } catch (e) {
      /*
       * `fetch` 直接抛 = 请求压根没发出去或响应被拦掉。最常见的是**跨域被拦**
       * （服务端 v0.11.5 之前没有 CORS，桌面端连自己的服务器都会栽在这里），
       * 而浏览器不会把跨域细节告诉 JS，原始错误只有一句 `Failed to fetch`。
       * 原样抛出去的话，用户看到的就是这四个词——这正是「登录报 Failed to fetch」
       * 查了一整轮才定位的原因。
       */
      const raw = e instanceof Error ? e.message : String(e);
      throw new ApiError(0, 'network_error', `连不上服务器（${raw}）。${FETCH_FAIL_HINT}`);
    }
    if (res.status === 401 && !retried && this.tokens.refresh) {
      await this.ensureRefreshed();
      return this.req<T>(path, init, true);
    }
    const body = (await res.json().catch(() => null)) as
      | { code?: string; message?: string }
      | null;
    if (!res.ok) {
      throw new ApiError(res.status, body?.code ?? 'http_error', body?.message ?? res.statusText);
    }
    return body as T;
  }

  /** refresh 轮换：并发请求只触发一次刷新 */
  private ensureRefreshed(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const res = await fetch(`${this.baseUrl}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: this.tokens.refresh }),
        });
        const body = (await res.json().catch(() => null)) as
          | { access_token?: string; refresh_token?: string; code?: string; message?: string }
          | null;
        if (!res.ok || !body?.access_token || !body?.refresh_token) {
          throw new ApiError(
            res.status,
            body?.code ?? 'refresh_failed',
            body?.message ?? '刷新登录态失败'
          );
        }
        const next = { access: body.access_token, refresh: body.refresh_token };
        this.tokens = next;
        this.onTokensRotated(next);
      })().finally(() => {
        this.refreshing = undefined;
      });
    }
    return this.refreshing;
  }

  // ---------- 认证 ----------

  static async login(serverUrl: string, email: string, password: string): Promise<LoginResult> {
    const res = await fetch(`${serverUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const body = (await res.json().catch(() => null)) as
      | (Partial<LoginResult> & { code?: string; message?: string })
      | null;
    if (!res.ok || !body?.access_token) {
      throw new ApiError(res.status, body?.code ?? 'login_failed', body?.message ?? '登录失败');
    }
    return body as LoginResult;
  }

  // ---------- Vault ----------

  listVaults(): Promise<{ vaults: { id: number; name: string; created_at: string }[] }> {
    return this.req('/vaults');
  }

  createVault(name: string): Promise<{ id: number; name: string }> {
    return this.req('/vaults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  }

  registerDevice(): Promise<{ device_id: string }> {
    return this.req('/devices', { method: 'POST' });
  }

  // ---------- MCP 长期令牌（P3 Agent 融合） ----------

  /**
   * 签发一张给 agent 用的长期令牌。**明文只在这一次响应里出现**，
   * 服务端只存 sha256，之后谁也拿不回来——界面必须当场让用户复制走。
   */
  createMcpToken(name: string): Promise<{ token: string; name: string; note: string }> {
    return this.req('/mcp/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  }

  listMcpTokens(): Promise<{ tokens: McpTokenInfo[] }> {
    return this.req('/mcp/tokens');
  }

  deleteMcpToken(id: number): Promise<{ deleted: number }> {
    return this.req(`/mcp/tokens/${id}`, { method: 'DELETE' });
  }

  // ---------- 同步 ----------

  push(vaultId: number, changes: PushChange[]): Promise<{ results: PushResult[] }> {
    return this.req('/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vault_id: vaultId, changes }),
    });
  }

  pullPage(
    vaultId: number,
    cursor: number,
    limit = 500
  ): Promise<{ changes: ServerChange[]; next_cursor: number }> {
    return this.req(`/sync/changes?vault_id=${vaultId}&cursor=${cursor}&limit=${limit}`);
  }

  // ---------- 文件历史（v0.11.24） ----------

  /**
   * 某路径的历史版本，新的在前。内容一直都在服务端（changes 只追加、blob 不删），
   * 这条只是把它们列出来；拿内容仍走 `getBlob(blob_hash)`。
   */
  history(vaultId: number, path: string, limit = 50): Promise<{ versions: HistoryVersion[] }> {
    return this.req(`/sync/history?vault_id=${vaultId}&path=${encodeURIComponent(path)}&limit=${limit}`);
  }

  /** 云端当前已删除的文件（全端共同的"可恢复"清单——回收站只在删除的那台设备上有） */
  deletedFiles(vaultId: number): Promise<{ files: DeletedFile[] }> {
    return this.req(`/sync/deleted?vault_id=${vaultId}`);
  }

  /*
   * blob 的收发**必须和其它请求一样会刷新登录态**。
   *
   * 这两个方法原来直接用 `raw`，绕开了 `req` 里的「401 → refresh → 重试一次」。
   * access token 只有 15 分钟：应用开着放一会儿，笔记正文（走 push/pull，会刷新）
   * 一切正常，而 blob 一律 401 —— 用户看到的就是那条红条
   * 「上传附件失败 HTTP 401」，而且**永远不会自己好**，因为谁也没去刷新。
   * v0.11.10 让附件也走 blob 之后，这条老路径从"偶尔"变成了"每次"。
   */
  // v0.11.11 修
  async getBlob(hash: string, retried = false): Promise<ArrayBuffer> {
    const res = await this.raw(`/blobs/${hash}`);
    if (res.status === 401 && !retried && this.tokens.refresh) {
      await this.ensureRefreshed();
      return this.getBlob(hash, true);
    }
    if (!res.ok) throw new ApiError(res.status, 'blob_error', `拉取附件失败 HTTP ${res.status}`);
    return res.arrayBuffer();
  }

  async putBlob(bytes: Uint8Array, retried = false): Promise<void> {
    const hash = await sha256Hex(bytes);
    const res = await this.raw(`/blobs/${hash}`, {
      method: 'PUT',
      body: bytes as unknown as BodyInit,
    });
    if (res.status === 401 && !retried && this.tokens.refresh) {
      await this.ensureRefreshed();
      return this.putBlob(bytes, true);
    }
    if (!res.ok) throw new ApiError(res.status, 'blob_error', `上传附件失败 HTTP ${res.status}`);
  }
}

// ---------- 工具 ----------

export { uuid };

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

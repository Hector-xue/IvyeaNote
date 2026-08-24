// Ivyea Note 同步协议 v1 客户端（契约见 shared/protocol.md）。
// 只依赖 fetch/WebSocket，浏览器与 Tauri 通用。

import type { Tokens } from './store';

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
export class SyncClient {
  private refreshing?: Promise<void>;

  constructor(
    private baseUrl: string, // 形如 https://notes.example.com/api/v1
    private tokens: Tokens,
    private onTokensRotated: (t: Tokens) => void,
    private deviceId = ''
  ) {
    if (!baseUrl.endsWith('/api/v1')) {
      throw new Error('baseUrl 必须以 /api/v1 结尾');
    }
  }

  // ---------- 底层请求 ----------

  private raw(path: string, init: RequestInit = {}, auth = true): Promise<Response> {
    const headers = new Headers(init.headers);
    if (auth) headers.set('Authorization', `Bearer ${this.tokens.access}`);
    if (this.deviceId) headers.set('X-Device-Id', this.deviceId);
    return fetch(this.baseUrl + path, { ...init, headers });
  }

  /** 带 401 自动 refresh 重试一次的 JSON 请求 */
  private async req<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
    const res = await this.raw(path, init);
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

  getBlob(hash: string): Promise<ArrayBuffer> {
    return this.raw(`/blobs/${hash}`).then(async (res) => {
      if (!res.ok) throw new ApiError(res.status, 'blob_error', `拉取附件失败 HTTP ${res.status}`);
      return res.arrayBuffer();
    });
  }

  async putBlob(bytes: Uint8Array): Promise<void> {
    const hash = await sha256Hex(bytes);
    const res = await this.raw(`/blobs/${hash}`, {
      method: 'PUT',
      body: bytes as unknown as BodyInit,
    });
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

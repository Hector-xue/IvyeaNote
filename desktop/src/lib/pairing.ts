/**
 * v0.6.1 H6：扫码/输码快速连接。
 * 流程：桌面已登录 → 「设置 → 添加设备」显示 6 位配对码（60 秒有效）；
 * 手机登录页点「我有配对码」→ 填服务器地址 + 配对码 → claim 成功直接登录，
 * 免输账号密码。
 */
import { apiBase, SyncClient } from '../lib/api';

export interface PairClaimResult {
  accessToken: string;
  refreshToken: string;
  userId: number;
}

/** 用服务器地址 + 配对码换取会话 */
export async function claimPairCode(serverUrl: string, code: string): Promise<PairClaimResult> {
  // 走 apiBase 而不是自己拼 `/api/v1`：老配置里存的地址可能**已经**带了 `/api/v1`
  //（v0.2.0 那阵的口径），自己拼就成了 /api/v1/api/v1，配对必失败。
  const res = await fetch(`${apiBase(serverUrl)}/pairing/claim?code=${encodeURIComponent(code)}`, {
    method: 'POST',
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error((body.message as string) ?? `配对失败（HTTP ${res.status}）`);
  }
  return {
    accessToken: body.access_token as string,
    refreshToken: body.refresh_token as string,
    userId: body.user_id as number,
  };
}

/** 桌面端：请求生成配对码 */
export async function createPairCode(client: SyncClient): Promise<{ code: string; expiresIn: number }> {
  const r = await client.createPairCode();
  return { code: r.code, expiresIn: r.expires_in };
}

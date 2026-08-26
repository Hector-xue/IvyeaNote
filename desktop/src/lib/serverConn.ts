/**
 * v0.6.0 H3：服务器连接辅助。
 * - normalizeServerUrl：智能补全协议（IP:端口 → http://，域名 → https://）
 * - probeServer：测试连接并分类错误，给人话诊断
 */

export interface ProbeResult {
  ok: boolean;
  /** 规范化后的 URL */
  url: string;
  /** 服务端版本（/healthz 或状态页返回时携带） */
  version?: string;
  /** 人话诊断 */
  message: string;
  /** 是否公网 http（明文警告） */
  insecurePublic?: boolean;
}

/** 智能补全协议：裸 IP/局域网 → http，域名 → https；补默认端口逻辑交给服务端 */
export function normalizeServerUrl(raw: string): string {
  let u = raw.trim().replace(/\/+$/, '');
  if (!u) return u;
  if (/^https?:\/\//i.test(u)) return u;
  // localhost / 裸 IPv4 / 以 . 结尾的内网主机名 → http（自托管本机场景）
  if (
    /^localhost(:\d+)?$/i.test(u) ||
    /^127\.\d+\.\d+\.\d+(:\d+)?$/.test(u) ||
    /^10\.\d+\.\d+\.\d+(:\d+)?$/.test(u) ||
    /^192\.168\.\d+\.\d+(:\d+)?$/.test(u) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+(:\d+)?$/.test(u) ||
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(u)
  ) {
    return `http://${u}`;
  }
  return `https://${u}`;
}

/** 是否公网 http（明文） */
export function isInsecurePublic(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'http:') return false;
    return !(
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
      hostname.endsWith('.local')
    );
  } catch {
    return false;
  }
}

/** 探测服务器：GET /healthz，超时 5 秒，错误分类 */
export async function probeServer(rawUrl: string): Promise<ProbeResult> {
  const url = normalizeServerUrl(rawUrl);
  if (!url || url === 'http://' || url === 'https://') {
    return { ok: false, url, message: '请先填写服务器地址' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${url}/healthz`, { signal: ctrl.signal });
    if (res.ok) {
      const ver = res.headers.get('X-Ivyea-Version') ?? undefined;
      return {
        ok: true,
        url,
        version: ver,
        message: `✓ 已连接到 Ivyea Server${ver ? ` v${ver}` : ''}`,
        insecurePublic: isInsecurePublic(url),
      };
    }
    return { ok: false, url, message: `服务端响应异常（HTTP ${res.status}），确认这是 Ivyea Server 的地址` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/abort/i.test(msg)) {
      return { ok: false, url, message: '连接超时：服务端没响应。检查它是否已启动、防火墙是否放行端口' };
    }
    if (/failed to fetch|network|load failed/i.test(msg)) {
      return {
        ok: false,
        url,
        message: '连不上：域名解析失败或服务未启动。本机部署填 http://127.0.0.1:8080；外网访问需要配置穿透（见部署引导）',
      };
    }
    return { ok: false, url, message: `连接失败：${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

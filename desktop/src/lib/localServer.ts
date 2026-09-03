/**
 * 内置同步服务端（v0.10.5，仅桌面）。
 *
 * 用户群体大多是「一台 Windows + 一部安卓」，而这个组合此前要同步，第一步是自己搭服务器。
 * 服务端其实默认就用 SQLite、密钥和管理员账号全自动生成——它本来就该跟客户端一起发。
 * 现在它是 Tauri sidecar，这里负责起停与凭据。
 *
 * 凭据由**本机生成并保存**：用户不需要自己想账号密码，也不需要记。
 * 这不是"给所有人一个默认密码"——每台电脑首次开启时随机生成一次，只存在本机。
 */

const CRED_KEY = 'ivnote.localServer.cred';

export interface LocalServerInfo {
  running: boolean;
  /** 本机地址 */
  url: string;
  /** 同一 Wi-Fi 下别的设备该用的地址；拿不到局域网 IP 时为 null */
  lanUrl: string | null;
}

export interface LocalCred {
  email: string;
  password: string;
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/**
 * 本机凭据。首次生成后一直复用——换一组就等于换了个账号，
 * 之前存在服务端 SQLite 里的笔记就找不回来了。
 */
export function localCred(): LocalCred {
  try {
    const raw = localStorage.getItem(CRED_KEY);
    if (raw) {
      const c = JSON.parse(raw) as LocalCred;
      if (c?.email && c?.password) return c;
    }
  } catch {
    /* 存储坏了就重新生成 */
  }
  const rand = (n: number) => {
    const bytes = new Uint8Array(n);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, n);
  };
  // 邮箱只是账号标识，服务端不会往外发信；固定域名 .local 避免被当成真实邮箱
  const cred: LocalCred = { email: `me-${rand(6)}@ivnote.local`, password: rand(24) };
  try {
    localStorage.setItem(CRED_KEY, JSON.stringify(cred));
  } catch {
    /* 存不下也能用完这一次，只是下次会换一组——比直接失败强 */
  }
  return cred;
}

/**
 * 这个服务器地址是不是"本机内置服务端"。
 * 停服务时要据此顺手退出登录——否则登录态还指着一个已经不存在的 127.0.0.1:8080，
 * 自动同步会每 60 秒撞一次墙，而设置里仍然写着"已登录"。
 */
export function isLocalServerAccount(serverUrl: string | undefined | null): boolean {
  if (!serverUrl) return false;
  try {
    const { hostname } = new URL(serverUrl);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

/** 这份构建里有没有附带服务端（源码构建/未来精简包可能没有） */
export async function localServerAvailable(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    return await call<boolean>('local_server_available');
  } catch {
    return false;
  }
}

export async function localServerStatus(): Promise<LocalServerInfo | null> {
  if (!isTauri()) return null;
  try {
    return await call<LocalServerInfo>('local_server_status');
  } catch {
    return null;
  }
}

/** 启动内置服务端并返回它的地址与本机凭据 */
export async function startLocalServer(): Promise<{ info: LocalServerInfo; cred: LocalCred }> {
  const cred = localCred();
  const info = await call<LocalServerInfo>('start_local_server', {
    email: cred.email,
    password: cred.password,
  });
  return { info, cred };
}

export async function stopLocalServer(): Promise<LocalServerInfo> {
  return call<LocalServerInfo>('stop_local_server');
}

/**
 * 安卓 SAF 文件适配器（v0.10.4）。
 *
 * 安卓上笔记默认存在 WebView 的 OPFS 里，也就是应用私有数据区——**卸载即清空**。
 * 走 Storage Access Framework 之后，笔记就落在用户自己选的目录里（`Documents/…`、
 * SD 卡、同步盘），卸载、换手机、用别的编辑器打开都不受影响。
 *
 * `vaultPath` 在这条路径下是一个 `content://` 树 URI（用户在系统目录选择器里选的），
 * 不是磁盘路径——所以判定用 {@link isSafPath} 而不是看有没有 `/`。
 *
 * 性能：SAF 每次目录查询都是一次跨进程调用，逐个文件问会慢到不可用。原生侧
 * 一次 `listEntries` 就把整棵树带回来并建好 路径→documentId 缓存，这里的
 * `list`/`listMeta` 因此都只是一次调用；`exists` 也走缓存，不再重新走树。
 */
import type { FileIO, FileMeta } from './sync';

/** `content://` 前缀＝SAF 树 URI，不是磁盘路径 */
export function isSafPath(p: string | null | undefined): boolean {
  return !!p && p.startsWith('content://');
}

interface SafEntry {
  path: string;
  mtime: number;
  size: number;
}

async function call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(`plugin:ivnote-saf|${cmd}`, args);
}

/** 让用户挑一个目录树；返回 null＝用户取消 */
export async function pickVaultFolder(): Promise<{ uri: string; name: string } | null> {
  try {
    return await call<{ uri: string; name: string }>('pick_vault_folder');
  } catch (e) {
    // 取消不是错误，不该弹红字；其余的往上抛，让调用方给出真正的原因
    if (/已取消|cancel/i.test(e instanceof Error ? e.message : String(e))) return null;
    throw e;
  }
}

// ---------- base64 ↔ 字节 ----------
// 二进制走 JSON 桥必须编码。这两个函数刻意不用 fetch/Blob：
// 附件读写在同步循环里会被调用很多次，多一次 await 就是多一帧卡顿。

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  // 分块拼接：一次 apply 几十万个参数会爆栈
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export const safIO: FileIO = {
  async list(vaultPath) {
    const entries = await call<SafEntry[]>('list_entries', { tree: vaultPath });
    return entries.map((e) => e.path);
  },

  async listMeta(vaultPath) {
    const entries = await call<SafEntry[]>('list_entries', { tree: vaultPath });
    return entries.map((e): FileMeta => ({ path: e.path, mtime: e.mtime, size: e.size }));
  },

  read(vaultPath, relPath) {
    return call<string>('read_text', { tree: vaultPath, path: relPath });
  },

  async write(vaultPath, relPath, content) {
    await call('write_text', { tree: vaultPath, path: relPath, content });
  },

  async readBinary(vaultPath, relPath) {
    const b64 = await call<string>('read_binary', { tree: vaultPath, path: relPath });
    return base64ToBytes(b64);
  },

  async writeBinary(vaultPath, relPath, data) {
    await call('write_binary', { tree: vaultPath, path: relPath, base64: bytesToBase64(data) });
  },

  async remove(vaultPath, relPath) {
    await call('remove_entry', { tree: vaultPath, path: relPath });
  },

  exists(vaultPath, relPath) {
    return call<boolean>('entry_exists', { tree: vaultPath, path: relPath });
  },
};

export const __testing = { base64ToBytes, bytesToBase64 };

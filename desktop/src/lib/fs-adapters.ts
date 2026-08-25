// 文件系统适配：Tauri 桌面端走真实磁盘（plugin-fs），纯浏览器开发时走 OPFS。
// 同步引擎只依赖 FileIO 接口，不关心底层实现。

import {
  readDir,
  readTextFile,
  writeTextFile,
  readFile,
  writeFile,
  remove,
  exists,
  mkdir,
  stat,
} from '@tauri-apps/plugin-fs';
import type { FileIO, FileMeta } from './sync';
import type { VaultMeta } from './store';

function join(base: string, rel: string): string {
  return base.endsWith('/') ? base + rel : `${base}/${rel}`;
}

function parentOf(abs: string): string {
  const i = abs.lastIndexOf('/');
  return i > 0 ? abs.slice(0, i) : '';
}

// ---------- Tauri 实现 ----------

async function walk(absDir: string, prefix: string, out: string[]): Promise<void> {
  const entries = await readDir(absDir);
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory) {
      await walk(join(absDir, e.name), rel, out);
    } else {
      out.push(rel);
    }
  }
}

export const tauriIO: FileIO = {
  async list(vaultPath) {
    const out: string[] = [];
    await walk(vaultPath, '', out);
    return out;
  },
  async listMeta(vaultPath) {
    const out: string[] = [];
    await walk(vaultPath, '', out);
    const metas: FileMeta[] = [];
    for (const rel of out) {
      try {
        const info = await stat(join(vaultPath, rel));
        metas.push({
          path: rel,
          mtime: info.mtime ? info.mtime.getTime() : 0,
          size: info.size,
        });
      } catch {
        metas.push({ path: rel, mtime: 0, size: 0 });
      }
    }
    return metas;
  },
  read(vaultPath, relPath) {
    return readTextFile(join(vaultPath, relPath));
  },
  async write(vaultPath, relPath, content) {
    const abs = join(vaultPath, relPath);
    const dir = parentOf(abs);
    if (dir) await mkdir(dir, { recursive: true }).catch(() => undefined);
    await writeTextFile(abs, content);
  },
  readBinary(vaultPath, relPath) {
    return readFile(join(vaultPath, relPath));
  },
  async writeBinary(vaultPath, relPath, data) {
    const abs = join(vaultPath, relPath);
    const dir = parentOf(abs);
    if (dir) await mkdir(dir, { recursive: true }).catch(() => undefined);
    await writeFile(abs, data);
  },
  remove(vaultPath, relPath) {
    return remove(join(vaultPath, relPath));
  },
  exists(vaultPath, relPath) {
    return exists(join(vaultPath, relPath));
  },
};

// ---------- 浏览器 OPFS 实现（开发调试用） ----------

type DirHandle = FileSystemDirectoryHandle & {
  values(): AsyncIterableIterator<FileSystemHandle>;
};

async function opfsVaultRoot(meta: VaultMeta): Promise<DirHandle> {
  const root = (await navigator.storage.getDirectory()) as unknown as DirHandle;
  return root.getDirectoryHandle(`vault-${meta.id}`, { create: true }) as Promise<DirHandle>;
}

async function opfsWalk(dir: DirHandle, prefix: string, out: string[]): Promise<void> {
  for await (const h of dir.values()) {
    const rel = prefix ? `${prefix}/${h.name}` : h.name;
    if (h.kind === 'directory') {
      await opfsWalk((await dir.getDirectoryHandle(h.name)) as DirHandle, rel, out);
    } else {
      out.push(rel);
    }
  }
}

async function opfsWalkMeta(
  dir: DirHandle,
  prefix: string,
  out: FileMeta[]
): Promise<void> {
  for await (const h of dir.values()) {
    const rel = prefix ? `${prefix}/${h.name}` : h.name;
    if (h.kind === 'directory') {
      await opfsWalkMeta((await dir.getDirectoryHandle(h.name)) as DirHandle, rel, out);
    } else {
      const file = await (h as FileSystemFileHandle).getFile();
      out.push({ path: rel, mtime: file.lastModified, size: file.size });
    }
  }
}

export function opfsIO(getMeta: () => VaultMeta): FileIO {
  const root = () => opfsVaultRoot(getMeta());
  return {
    async list() {
      const out: string[] = [];
      await opfsWalk(await root(), '', out);
      return out;
    },
    async listMeta() {
      const out: FileMeta[] = [];
      await opfsWalkMeta(await root(), '', out);
      return out;
    },
    async read(_vp, relPath) {
      const fh = await (await root()).getFileHandle(relPath, { create: false });
      return fh.getFile().then((f) => f.text());
    },
    async write(_vp, relPath, content) {
      const parts = relPath.split('/');
      let dir = await root();
      for (const seg of parts.slice(0, -1)) {
        dir = (await dir.getDirectoryHandle(seg, { create: true })) as DirHandle;
      }
      const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
      const writable = await fh.createWritable();
      await writable.write(content);
      await writable.close();
    },
    async readBinary(_vp, relPath) {
      const fh = await (await root()).getFileHandle(relPath, { create: false });
      const buf = await fh.getFile().then((f) => f.arrayBuffer());
      return new Uint8Array(buf);
    },
    async writeBinary(_vp, relPath, data) {
      const parts = relPath.split('/');
      let dir = await root();
      for (const seg of parts.slice(0, -1)) {
        dir = (await dir.getDirectoryHandle(seg, { create: true })) as DirHandle;
      }
      const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
      const writable = await fh.createWritable();
      // 拷贝到 ArrayBuffer 视图，满足 FileSystemWriteChunkType 的严格泛型
      await writable.write(new Uint8Array(data));
      await writable.close();
    },
    async remove(_vp, relPath) {
      await (await root()).removeEntry(relPath);
    },
    async exists(_vp, relPath) {
      try {
        await (await root()).getFileHandle(relPath, { create: false });
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * 把一个存储里的全部 .md 笔记复制到另一个存储（登录迁移用）。
 * 墓碑路径：源里已不存在而目标还在的，一并删除（离线期删除的笔记不复活）。
 * 返回复制的文件数。
 */
export async function migrateFiles(
  src: FileIO,
  srcPath: string,
  dst: FileIO,
  dstPath: string,
  tombstones?: Record<string, number>
): Promise<number> {
  let n = 0;
  for (const rel of await src.list(srcPath)) {
    if (!/\.(md|markdown)$/i.test(rel)) continue;
    await dst.write(dstPath, rel, await src.read(srcPath, rel));
    n++;
  }
  if (tombstones) {
    for (const p of Object.keys(tombstones)) {
      const stillLocal = await src.exists(srcPath, p).catch(() => false);
      if (stillLocal) continue;
      if (await dst.exists(dstPath, p).catch(() => false)) await dst.remove(dstPath, p);
    }
  }
  return n;
}

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

/**
 * 拼库内绝对路径。
 *
 * v0.11.4：在 Windows 上用反斜杠。此前一律用 `/`，于是拼出
 * `E:\obsidian\obsidian/亚马逊/图.png` 这种两种分隔符混着的路径——
 * 它能用，但报错信息难读，作用域匹配也多一层不确定性。
 */
const SEP = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent) ? '\\' : '/';

function join(base: string, rel: string): string {
  const b = base.replace(/[\\/]+$/, '');
  return b + SEP + (SEP === '\\' ? rel.replace(/\//g, '\\') : rel);
}

/**
 * 取父目录。**两种分隔符都要认**。
 *
 * v0.11.4 把 `join` 在 Windows 上改成了反斜杠，这里却还只找 `/`——于是 Windows 上
 * `lastIndexOf('/')` 恒为 -1，父目录成了空串，`write`/`writeBinary` 里的
 * `mkdir(dir, {recursive:true})` 整句被跳过。后果是**凡是要新建目录的写入全废**：
 * 第一次删除笔记（要写 `.trash/…`）、新建文件夹（写 `子目录/.keep`）、
 * 往新子目录里粘图片、以及同步拉取远端新目录下的笔记——全部以「写入失败」告终。
 */
function parentOf(abs: string): string {
  const i = Math.max(abs.lastIndexOf('/'), abs.lastIndexOf('\\'));
  return i > 0 ? abs.slice(0, i) : '';
}

/**
 * 不进这个目录。
 *
 * `.git`、`.obsidian`、`.trash`（我们自己的回收站除外）这类点目录在 Obsidian 里
 * 是隐藏的，这边却整棵树扫进来：侧栏被 `.git/objects/…` 淹掉不说，`listMeta`
 * 还要对每个文件 `stat` 一次——一个正常大小的 git 仓库就能让每次刷新卡上几秒。
 * 自己的 `.trash`/`.ivyea` 必须留着：回收站面板和索引快照要读它们。
 */
const OWN_DOT_DIRS = new Set(['.trash', '.ivyea']);
/**
 * 点开头的**文件**同样隐藏（`.gitignore`、`.DS_Store`…），Obsidian 也是这么做的。
 * `.keep` 是我们自己的空文件夹占位，去掉它「新建文件夹」就等于点了没反应。
 */
const OWN_DOT_FILES = new Set(['.keep']);

export function isSkippedDir(name: string): boolean {
  return name.startsWith('.') && !OWN_DOT_DIRS.has(name);
}

export function isSkippedFile(name: string): boolean {
  return name.startsWith('.') && !OWN_DOT_FILES.has(name);
}

/** 路径（相对库根）是否落在被跳过的点目录里 */
export function inSkippedDir(rel: string): boolean {
  const segs = rel.split('/');
  return segs.slice(0, -1).some(isSkippedDir) || isSkippedFile(segs[segs.length - 1] ?? '');
}

// ---------- Tauri 实现 ----------

async function walk(absDir: string, prefix: string, out: string[]): Promise<void> {
  const entries = await readDir(absDir);
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory) {
      if (isSkippedDir(e.name)) continue;
      await walk(join(absDir, e.name), rel, out);
    } else {
      if (isSkippedFile(e.name)) continue;
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

/**
 * v0.11.25：删除库时把它在 OPFS 里的目录整个拿掉（`vault-<id>`）。
 * 只对应用内部存储；绑定的磁盘文件夹 / SAF 目录**永远不动**——那是用户的文件。
 */
export async function removeOpfsVault(id: number): Promise<void> {
  const root = (await navigator.storage.getDirectory()) as unknown as DirHandle & {
    removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
  };
  try {
    await root.removeEntry(`vault-${id}`, { recursive: true });
  } catch (e) {
    // 目录本来就不存在（从没写过东西）不算失败
    if ((e as { name?: string })?.name !== 'NotFoundError') throw e;
  }
}

async function opfsWalk(dir: DirHandle, prefix: string, out: string[]): Promise<void> {
  for await (const h of dir.values()) {
    const rel = prefix ? `${prefix}/${h.name}` : h.name;
    if (h.kind === 'directory') {
      if (isSkippedDir(h.name)) continue;
      await opfsWalk((await dir.getDirectoryHandle(h.name)) as DirHandle, rel, out);
    } else {
      if (isSkippedFile(h.name)) continue;
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
      if (isSkippedDir(h.name)) continue;
      await opfsWalkMeta((await dir.getDirectoryHandle(h.name)) as DirHandle, rel, out);
    } else {
      if (isSkippedFile(h.name)) continue;
      const file = await (h as FileSystemFileHandle).getFile();
      out.push({ path: rel, mtime: file.lastModified, size: file.size });
    }
  }
}

/**
 * 把库内相对路径解析成「所在目录句柄 + 文件名」。
 *
 * OPFS 的 `getFileHandle` / `removeEntry` 只收**一段**名字，塞进 `日记/2026-08-29.md`
 * 这种带斜杠的路径会直接抛 `Name is not allowed`。原来只有 write/writeBinary 记得
 * 逐段走目录，read/readBinary/remove/exists 四个都是直接把整条路径递进去——于是在
 * 本地模式（opfs://）下，**任何子目录里的笔记都打不开、删不掉，exists 还恒为 false**
 * （改名的「不抢名」判断、日记的「今天已经有了」判断都建立在 exists 上）。
 *
 * @param create true 时逐段建目录（写入路径用）；false 时目录不存在直接抛（读取路径用）
 */
async function opfsLocate(
  rootDir: DirHandle,
  relPath: string,
  create: boolean
): Promise<{ dir: DirHandle; name: string }> {
  const parts = relPath.split('/').filter(Boolean);
  if (parts.length === 0) throw new Error(`空路径：${relPath}`);
  let dir = rootDir;
  for (const seg of parts.slice(0, -1)) {
    dir = (await dir.getDirectoryHandle(seg, { create })) as DirHandle;
  }
  return { dir, name: parts[parts.length - 1] };
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
      const { dir, name } = await opfsLocate(await root(), relPath, false);
      const fh = await dir.getFileHandle(name, { create: false });
      return fh.getFile().then((f) => f.text());
    },
    async write(_vp, relPath, content) {
      const { dir, name } = await opfsLocate(await root(), relPath, true);
      const fh = await dir.getFileHandle(name, { create: true });
      const writable = await fh.createWritable();
      await writable.write(content);
      await writable.close();
    },
    async readBinary(_vp, relPath) {
      const { dir, name } = await opfsLocate(await root(), relPath, false);
      const fh = await dir.getFileHandle(name, { create: false });
      const buf = await fh.getFile().then((f) => f.arrayBuffer());
      return new Uint8Array(buf);
    },
    async writeBinary(_vp, relPath, data) {
      const { dir, name } = await opfsLocate(await root(), relPath, true);
      const fh = await dir.getFileHandle(name, { create: true });
      const writable = await fh.createWritable();
      // 拷贝到 ArrayBuffer 视图，满足 FileSystemWriteChunkType 的严格泛型
      await writable.write(new Uint8Array(data));
      await writable.close();
    },
    async remove(_vp, relPath) {
      const { dir, name } = await opfsLocate(await root(), relPath, false);
      await dir.removeEntry(name);
    },
    async exists(_vp, relPath) {
      try {
        const { dir, name } = await opfsLocate(await root(), relPath, false);
        await dir.getFileHandle(name, { create: false });
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
  const copied: string[] = [];
  for (const rel of await src.list(srcPath)) {
    /*
     * v0.11.25：**附件也搬**。此前只搬 `.md`——库从应用内部存储移到磁盘文件夹时，
     * 图片和 PDF 全留在 OPFS 里，新位置里的笔记一打开全是裂图。
     * `.ivyea/`（索引缓存）与 `.trash/`（本机回收站）是这个位置自己的派生数据，不搬。
     */
    if (rel.startsWith('.ivyea/') || rel.startsWith('.trash/')) continue;
    if (/\.(md|markdown)$/i.test(rel)) await dst.write(dstPath, rel, await src.read(srcPath, rel));
    else await dst.writeBinary(dstPath, rel, await src.readBinary(srcPath, rel));
    copied.push(rel);
  }
  /*
   * v0.11.27：复制完**回头数一遍**。安卓 SAF 那次（2026-09-12）目标端把 `CNC.md` 落成了
   * `CNC.md.txt`，write 却一路成功——库指向新位置后一篇也对不上，每同步一轮多一份副本。
   * 这里以目标端自己的 list 为准：少一个就整体失败，调用方不会切 localPath，笔记留在原地。
   */
  if (copied.length > 0) {
    const got = new Set(await dst.list(dstPath));
    const missing = copied.filter((p) => !got.has(p));
    if (missing.length > 0) {
      throw new Error(`复制后在新位置找不到 ${missing.length} 个文件（如 ${missing[0]}），已放弃`);
    }
  }
  const n = copied.length;
  if (tombstones) {
    for (const p of Object.keys(tombstones)) {
      const stillLocal = await src.exists(srcPath, p).catch(() => false);
      if (stillLocal) continue;
      if (await dst.exists(dstPath, p).catch(() => false)) await dst.remove(dstPath, p);
    }
  }
  return n;
}

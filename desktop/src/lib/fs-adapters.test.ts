/**
 * OPFS 适配器的子目录行为锁定。
 *
 * 起因：本地模式（`opfs://`，新用户点「新建空白库」后的默认存储）下，命令面板的
 * 「打开今日笔记」建出 `日记/2026-08-29.md` 之后立刻报
 * `Failed to execute 'getFileHandle' … Name is not allowed.`——
 * `getFileHandle` 只收一段名字，带斜杠的路径直接抛。
 *
 * write / writeBinary 当初记得逐段走目录，read / readBinary / remove / exists 四个没有。
 * 于是子目录里的笔记打不开、删不掉，且 `exists` 恒为 false——而「改名不抢名」和
 * 「今天的日记是不是已经有了」都建立在 exists 上。
 *
 * 这里用一个内存版 OPFS 假实现盯死四个方法都会拆路径。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { opfsIO } from './fs-adapters';
import type { VaultMeta } from './store';

// ---------- 内存版 OPFS ----------

class FakeFile {
  constructor(public data: string | Uint8Array) {}
  text() {
    return Promise.resolve(
      typeof this.data === 'string' ? this.data : new TextDecoder().decode(this.data)
    );
  }
  arrayBuffer() {
    const bytes =
      typeof this.data === 'string' ? new TextEncoder().encode(this.data) : this.data;
    return Promise.resolve(bytes.buffer.slice(0) as ArrayBuffer);
  }
  get size() {
    return typeof this.data === 'string' ? this.data.length : this.data.length;
  }
  lastModified = 1;
}

class FakeFileHandle {
  kind = 'file' as const;
  constructor(public name: string, public file: FakeFile) {}
  getFile() {
    return Promise.resolve(this.file);
  }
  createWritable() {
    const h = this;
    return Promise.resolve({
      write(chunk: string | Uint8Array) {
        h.file = new FakeFile(chunk);
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    });
  }
}

class FakeDirHandle {
  kind = 'directory' as const;
  dirs = new Map<string, FakeDirHandle>();
  files = new Map<string, FakeFileHandle>();
  constructor(public name: string) {}

  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    if (name.includes('/')) throw new DOMException('Name is not allowed.', 'TypeError');
    let d = this.dirs.get(name);
    if (!d) {
      if (!opts?.create) throw new DOMException('not found', 'NotFoundError');
      d = new FakeDirHandle(name);
      this.dirs.set(name, d);
    }
    return d;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }) {
    // 真实 OPFS 的行为：名字里带斜杠直接拒绝——这正是当初的 bug
    if (name.includes('/')) throw new DOMException('Name is not allowed.', 'TypeError');
    let f = this.files.get(name);
    if (!f) {
      if (!opts?.create) throw new DOMException('not found', 'NotFoundError');
      f = new FakeFileHandle(name, new FakeFile(''));
      this.files.set(name, f);
    }
    return f;
  }
  async removeEntry(name: string) {
    if (name.includes('/')) throw new DOMException('Name is not allowed.', 'TypeError');
    if (!this.files.delete(name) && !this.dirs.delete(name)) {
      throw new DOMException('not found', 'NotFoundError');
    }
  }
  async *values() {
    for (const d of this.dirs.values()) yield d;
    for (const f of this.files.values()) yield f;
  }
}

let storageRoot: FakeDirHandle;

const meta = { id: 1, name: '本地', localPath: 'opfs://local' } as unknown as VaultMeta;
const io = opfsIO(() => meta);

beforeEach(() => {
  storageRoot = new FakeDirHandle('');
  Object.defineProperty(globalThis, 'navigator', {
    value: { storage: { getDirectory: () => Promise.resolve(storageRoot) } },
    configurable: true,
    writable: true,
  });
});

describe('OPFS 子目录（本地模式的默认存储）', () => {
  it('写进子目录后能读回来——原来这里抛 Name is not allowed', async () => {
    await io.write('', '日记/2026-08-29.md', '# 今天');
    await expect(io.read('', '日记/2026-08-29.md')).resolves.toBe('# 今天');
  });

  it('exists 认得子目录里的文件（改名不抢名、日记不重建都靠它）', async () => {
    await io.write('', '日记/2026-08-29.md', 'x');
    await expect(io.exists('', '日记/2026-08-29.md')).resolves.toBe(true);
    await expect(io.exists('', '日记/2026-08-30.md')).resolves.toBe(false);
    await expect(io.exists('', '不存在的目录/x.md')).resolves.toBe(false);
  });

  it('remove 能删掉子目录里的文件——删不掉会让「移动」退化成「复制」', async () => {
    await io.write('', '归档/旧.md', 'x');
    await io.remove('', '归档/旧.md');
    await expect(io.exists('', '归档/旧.md')).resolves.toBe(false);
  });

  it('多层目录同样成立', async () => {
    await io.write('', 'a/b/c/深.md', 'deep');
    await expect(io.read('', 'a/b/c/深.md')).resolves.toBe('deep');
    await expect(io.exists('', 'a/b/c/深.md')).resolves.toBe(true);
  });

  it('二进制读写也拆路径（附件都在 Attachments/ 下）', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await io.writeBinary('', 'Attachments/20260829-图.png', bytes);
    await expect(io.readBinary('', 'Attachments/20260829-图.png')).resolves.toEqual(bytes);
  });

  it('根目录下的文件不受影响', async () => {
    await io.write('', '首页.md', 'home');
    await expect(io.read('', '首页.md')).resolves.toBe('home');
    await expect(io.exists('', '首页.md')).resolves.toBe(true);
    await io.remove('', '首页.md');
    await expect(io.exists('', '首页.md')).resolves.toBe(false);
  });

  it('list / listMeta 递归列出子目录里的笔记', async () => {
    await io.write('', '首页.md', 'a');
    await io.write('', '日记/一.md', 'b');
    await io.write('', 'a/b/深.md', 'c');
    const list = (await io.list('')).sort();
    expect(list).toEqual(['a/b/深.md', '日记/一.md', '首页.md'].sort());
    const metas = (await io.listMeta('')).map((m) => m.path).sort();
    expect(metas).toEqual(list);
  });

  it('读不存在的文件仍然抛错（不能被 locate 吞掉）', async () => {
    await expect(io.read('', '没有/这个.md')).rejects.toBeTruthy();
  });
});

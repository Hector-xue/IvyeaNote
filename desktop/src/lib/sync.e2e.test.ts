// @vitest-environment node
/**
 * 端到端同步验证：**真的 Go 服务端 + 真的磁盘目录 + 真的客户端代码**。
 *
 * 为什么非要有这一层（v0.11.11 补，起因是自己捅的两个篓子）：
 *
 * v0.11.10 把"附件也同步"接上时，只在内存假文件系统 + 一个从不返 401 的假服务端上
 * 验过，结果上线即坏，而且是最糟的那种坏——**整条同步链路停摆**：
 *
 * 1. 真库里有 `io.list()` 故意保留的 `.ivyea/`（应用自己的索引缓存）。假的内存 FS
 *    里不存在这个目录，于是"非 .md 一律同步"把它推上了云。
 * 2. 真服务端的 access token 15 分钟过期，而 `getBlob/putBlob` 绕开了 `req` 的
 *    401 刷新。假服务端永远返 200，这条路径永远测不到。
 * 3. 一个文件失败就 `return`，拉取整段被跳过——"桌面端改的笔记手机端看不到"。
 *
 * 三条的共同点：**假件比真件宽松**。这个文件里的每一条都跑在真东西上。
 *
 * 没有 Go 工具链时整组跳过（并打印原因），不让本地开发被卡住；CI 上装了 Go，跑得到。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SyncClient } from './api';
import { pushOnly, pullOnly, syncVault, type FileIO } from './sync';
import { newVaultMeta } from './store';

const SERVER_DIR = path.resolve(__dirname, '../../../server');

function goBin(): string | null {
  for (const c of ['go', '/usr/local/go/bin/go', '/usr/lib/golang/bin/go']) {
    const r = spawnSync(c, ['version'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}

/** 磁盘上的真文件系统适配器（桌面端 tauriIO 的等价物，用 node:fs 实现） */
function diskIO(): FileIO {
  const walk = (root: string, dir: string, prefix: string, out: string[]) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // 与 fs-adapters 同一套规矩：点目录里只有 .trash / .ivyea 留下（它们要给应用自己读）
        if (e.name.startsWith('.') && e.name !== '.trash' && e.name !== '.ivyea') continue;
        walk(root, path.join(dir, e.name), rel, out);
      } else {
        if (e.name.startsWith('.') && e.name !== '.keep') continue;
        out.push(rel);
      }
    }
  };
  return {
    async list(vaultPath) {
      const out: string[] = [];
      walk(vaultPath, vaultPath, '', out);
      return out;
    },
    async listMeta(vaultPath) {
      const out: string[] = [];
      walk(vaultPath, vaultPath, '', out);
      return out.map((p) => {
        const st = statSync(path.join(vaultPath, p));
        return { path: p, mtime: st.mtimeMs, size: st.size };
      });
    },
    async read(vaultPath, rel) {
      return readFileSync(path.join(vaultPath, rel), 'utf8');
    },
    async write(vaultPath, rel, content) {
      const abs = path.join(vaultPath, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content, 'utf8');
    },
    async readBinary(vaultPath, rel) {
      return new Uint8Array(readFileSync(path.join(vaultPath, rel)));
    },
    async writeBinary(vaultPath, rel, data) {
      const abs = path.join(vaultPath, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, data);
    },
    async remove(vaultPath, rel) {
      rmSync(path.join(vaultPath, rel), { force: true });
    },
    async exists(vaultPath, rel) {
      return existsSync(path.join(vaultPath, rel));
    },
  };
}

const go = goBin();
const suite = go ? describe : describe.skip;
if (!go) console.warn('[sync.e2e] 找不到 go 工具链，跳过真服务端端到端验证');

suite('端到端：真服务端 + 真目录', () => {
  let proc: ChildProcess | undefined;
  let base = '';
  let workdir = '';
  let tokens = { access: '', refresh: '' };
  let vaultId = 0;

  beforeAll(async () => {
    workdir = mkdtempSync(path.join(tmpdir(), 'ivnote-e2e-'));
    const port = 18000 + Math.floor(Math.random() * 900);
    base = `http://127.0.0.1:${port}`;
    /*
     * **先编成一个可执行文件再跑，不要 `go run`。**
     *
     * `go run` 会另起一个子进程跑编出来的程序：Windows 上 `proc.kill()` 杀掉的是
     * 外层那个 wrapper，真正的服务端还活着、还占着 `e2e.db` 的文件句柄，
     * 于是 `afterAll` 里的 `rmSync` 撞 EBUSY，整组用例连带整个 Windows 打包任务变红
     * （v0.11.11 发版时就是这么挂的——593 个测试全过，栽在清理上）。
     * 直接 spawn 二进制，`kill` 打的就是服务端本身；顺带每次少编一遍。
     */
    const exe = path.join(workdir, process.platform === 'win32' ? 'ivnote-e2e.exe' : 'ivnote-e2e');
    const built = spawnSync(go!, ['build', '-o', exe, './cmd/ivnote-server'], {
      cwd: SERVER_DIR,
      encoding: 'utf8',
    });
    if (built.status !== 0) throw new Error(`编译服务端失败：${built.stderr || built.stdout}`);
    proc = spawn(exe, [], {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        IVNOTE_LISTEN: `127.0.0.1:${port}`,
        IVNOTE_SQLITE_PATH: path.join(workdir, 'e2e.db'),
        IVNOTE_SECRET: 'e2e-secret-e2e-secret-e2e-secret-32',
        IVNOTE_OPEN_REGISTRATION: '1',
      },
      stdio: 'ignore',
    });
    // 等它起来（go run 首次要编译，给足时间）
    for (let i = 0; i < 120; i++) {
      try {
        const r = await fetch(`${base}/healthz`);
        if (r.ok) break;
      } catch {
        /* 还没起来 */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    const email = `e2e-${Date.now()}@ivyea.test`;
    await fetch(`${base}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'password-123456' }),
    });
    const login = (await (
      await fetch(`${base}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'password-123456' }),
      })
    ).json()) as { access_token: string; refresh_token: string };
    tokens = { access: login.access_token, refresh: login.refresh_token };
    const vault = (await (
      await fetch(`${base}/api/v1/vaults`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.access}` },
        body: JSON.stringify({ name: 'e2e' }),
      })
    ).json()) as { id: number };
    vaultId = vault.id;
  }, 120_000);

  afterAll(async () => {
    // 等它**真的**退出再删目录：Windows 上进程没走干净，文件句柄就还在
    if (proc && proc.exitCode === null) {
      const exited = new Promise<void>((resolve) => proc!.once('exit', () => resolve()));
      proc.kill('SIGKILL');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    }
    // 删不掉就算了：留一个临时目录，绝不能让清理失败把整轮测试判红
    for (let i = 0; i < 3; i++) {
      try {
        if (workdir) rmSync(workdir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  });

  /** 一段不是合法 UTF-8 的字节，用来验"PDF 没被当文本走一遍编解码" */
  const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0x01, 0x80]);

  it('PDF 与图片真的能上去、真的能下来，且逐字节一致；.ivyea/ 与 .trash/ 一个字节都不上传', async () => {
    const io = diskIO();
    const A = path.join(workdir, 'A');
    const B = path.join(workdir, 'B');
    mkdirSync(path.join(A, '.ivyea/cache'), { recursive: true });
    mkdirSync(path.join(A, '.trash'), { recursive: true });
    mkdirSync(path.join(A, 'Attachments'), { recursive: true });
    mkdirSync(B, { recursive: true });
    writeFileSync(path.join(A, '笔记.md'), '# 标题\n正文\n');
    writeFileSync(path.join(A, 'Attachments/手册.pdf'), PDF);
    writeFileSync(path.join(A, '.ivyea/cache/content.json'), '{"index":"本机缓存"}');
    writeFileSync(path.join(A, '.trash/删掉的.md'), '回收站里的东西');

    const clientA = new SyncClient(base, { ...tokens }, (t) => (tokens = t), 'device-A');
    const metaA = newVaultMeta(vaultId, 'e2e');
    const up = await syncVault(clientA, metaA, io, 'device-A', A);
    expect(up.errors).toEqual([]);
    expect(up.pushed).toBe(2); // 笔记 + PDF，仅此而已

    const clientB = new SyncClient(base, { ...tokens }, () => undefined, 'device-B');
    const metaB = newVaultMeta(vaultId, 'e2e');
    const down = await pullOnly(clientB, metaB, io, 'device-B', B);
    expect(down.errors).toEqual([]);

    // PDF 下来了，且逐字节一致
    expect(new Uint8Array(readFileSync(path.join(B, 'Attachments/手册.pdf')))).toEqual(PDF);
    expect(readFileSync(path.join(B, '笔记.md'), 'utf8')).toContain('正文');
    // 本机私有目录没上去，也没落到另一台
    expect(existsSync(path.join(B, '.ivyea/cache/content.json'))).toBe(false);
    expect(existsSync(path.join(B, '.trash/删掉的.md'))).toBe(false);
  }, 60_000);

  it('access token 过期时附件照样传得上去（blob 会自己刷新登录态）', async () => {
    const io = diskIO();
    const C = path.join(workdir, 'C');
    mkdirSync(C, { recursive: true });
    writeFileSync(path.join(C, '过期后.pdf'), PDF);

    // 拿一个**必然失效**的 access token（refresh 是好的）——真实世界里就是放了 15 分钟
    const client = new SyncClient(
      base,
      { access: 'expired.token.value', refresh: tokens.refresh },
      (t) => (tokens = t),
      'device-C'
    );
    const meta = newVaultMeta(vaultId, 'e2e');
    const r = await pushOnly(client, meta, io, 'device-C', C);
    expect(r.errors).toEqual([]);
    expect(r.pushed).toBe(1);
  }, 60_000);

  it('一个附件传不上去，不该连累其余的同步（拉取照跑）', async () => {
    const io = diskIO();
    const D = path.join(workdir, 'D');
    mkdirSync(D, { recursive: true });
    // 51MB：服务端明确拒收（maxBlobSize 50MB）
    writeFileSync(path.join(D, '超大.bin'), Buffer.alloc((50 << 20) + 1));

    const client = new SyncClient(base, { ...tokens }, (t) => (tokens = t), 'device-D');
    const meta = newVaultMeta(vaultId, 'e2e');
    const r = await syncVault(client, meta, io, 'device-D', D);

    expect(r.errors.join()).toMatch(/50MB/); // 那一个说清楚
    expect(existsSync(path.join(D, '笔记.md'))).toBe(true); // 其余照常拉下来
    expect(existsSync(path.join(D, 'Attachments/手册.pdf'))).toBe(true);
  }, 120_000);
});

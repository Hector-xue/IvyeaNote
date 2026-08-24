import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LoginView } from './ui/LoginView';
import { SetupGuide } from './ui/SetupGuide';
import { MainView } from './ui/MainView';
import { MobileView } from './ui/MobileView';
import { ApiError, SyncClient } from './lib/api';
import { syncVault, pushOnly, pullOnly, type FileIO, type SyncReport } from './lib/sync';
import { tauriIO, opfsIO } from './lib/fs-adapters';
import {
  loadState,
  saveState,
  clearState,
  newVaultMeta,
  type PersistState,
  type VaultMeta,
} from './lib/store';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** 移动端判定：窄屏或触屏设备（UA 粗判），命中即用 MobileView 单栏布局 */
function useIsMobile(): boolean {
  const [m, setM] = useState(() => window.matchMedia('(max-width: 768px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const fn = () => setM(mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  return m;
}

function errText(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

export default function App() {
  const [state, setState] = useState<PersistState>(() => loadState());
  const [vaultId, setVaultId] = useState<number | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [doc, setDoc] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [lastReport, setLastReport] = useState<SyncReport | null>(null);
  const [importing, setImporting] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(
    () => (localStorage.getItem('ivnote.theme') as 'light' | 'dark') || 'light'
  );

  const stateRef = useRef(state);
  stateRef.current = state;
  const syncingRef = useRef(false);

  const persist = useCallback((next: PersistState) => {
    stateRef.current = next;
    setState(next);
    saveState(next);
  }, []);

  const patchVault = useCallback(
    (id: number, fn: (m: VaultMeta) => void) => {
      const cur = stateRef.current;
      const meta = cur.vaults[String(id)];
      if (!meta) return;
      fn(meta);
      persist({ ...cur, vaults: { ...cur.vaults } });
    },
    [persist]
  );

  const client = useMemo(() => {
    const acc = state.account;
    if (!acc) return null;
    return new SyncClient(acc.serverUrl, acc.tokens, (t) => {
      const cur = stateRef.current;
      if (cur.account) persist({ ...cur, account: { ...cur.account, tokens: t } });
    }, acc.deviceId);
  }, [state.account?.serverUrl, state.account === undefined]); // eslint-disable-line react-hooks/exhaustive-deps

  const vault: VaultMeta | null = vaultId ? state.vaults[String(vaultId)] ?? null : null;

  // 文件 IO：绑定了本地文件夹且在 Tauri 里 → 真实磁盘；否则 OPFS
  const io: FileIO = useMemo(() => {
    if (vault?.localPath && isTauri) return tauriIO;
    return opfsIO(() => {
      const m = stateRef.current.vaults[String(vaultId ?? '')];
      return m ?? newVaultMeta(-1, 'tmp');
    });
  }, [vault?.localPath, vaultId]);

  const refreshFiles = useCallback(async () => {
    if (!vault) return;
    try {
      const list = await io.list(vault.localPath ?? '');
      setFiles(list.filter((p) => /\.md$/i.test(p)).sort());
    } catch (e) {
      console.error('列出文件失败', e);
    }
  }, [vault, io]);

  /** 执行一轮完整同步（推送本地增量 + 拉取远端变更） */
  const doSync = useCallback(async () => {
    if (!client || !vault || syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      const report = await syncVault(client, vault, io, stateRef.current.account!.deviceId, vault.localPath ?? '');
      setLastReport(report);
      await refreshFiles();
      persist({ ...stateRef.current });
    } catch (e) {
      console.error('同步失败', e);
      setLastReport({
        pushed: 0,
        pulled: 0,
        merged: 0,
        conflicts: [],
        errors: [errText(e)],
      });
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [client, vault, io, refreshFiles, persist]);

  /** 只上传：把本地修改推到服务器 */
  const doUpload = useCallback(async () => {
    if (!client || !vault || syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      const report = await pushOnly(client, vault, io, stateRef.current.account!.deviceId, vault.localPath ?? '');
      setLastReport(report);
      await refreshFiles();
      persist({ ...stateRef.current });
    } catch (e) {
      setLastReport({ pushed: 0, pulled: 0, merged: 0, conflicts: [], errors: [errText(e)] });
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [client, vault, io, refreshFiles, persist]);

  /** 只拉取：把服务器上的变更拉到本机 */
  const doDownload = useCallback(async () => {
    if (!client || !vault || syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      const report = await pullOnly(client, vault, io, stateRef.current.account!.deviceId, vault.localPath ?? '');
      setLastReport(report);
      await refreshFiles();
      if (currentPath) {
        try {
          setDoc(await io.read(vault.localPath ?? '', currentPath));
        } catch {
          setCurrentPath(null);
          setDoc(null);
        }
      }
      persist({ ...stateRef.current });
    } catch (e) {
      setLastReport({ pushed: 0, pulled: 0, merged: 0, conflicts: [], errors: [errText(e)] });
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [client, vault, io, refreshFiles, persist, currentPath]);

  // ---------- 登录 / 注册 ----------

  const finishLogin = useCallback(
    async (serverUrl: string, email: string, userId: number, access: string, refresh: string) => {
      // 先用临时 client 注册设备，拿到 device_id 后再落盘
      const tmpTokens = { access, refresh };
      let deviceId = '';
      try {
        const tmp = new SyncClient(serverUrl, tmpTokens, () => undefined);
        deviceId = (await tmp.registerDevice()).device_id;
      } catch {
        deviceId = `local-${crypto.randomUUID()}`; // 注册失败不阻塞登录
      }
      const acc = { serverUrl, email, userId, deviceId, tokens: tmpTokens };
      const cur = loadState();
      // 拉取服务端 vault 列表并合并（保留本地已有元数据）
      const merged: Record<string, VaultMeta> = {};
      try {
        const c = new SyncClient(serverUrl, acc.tokens, () => undefined, deviceId);
        const { vaults } = await c.listVaults();
        for (const v of vaults) {
          merged[String(v.id)] = cur.vaults[String(v.id)] ?? newVaultMeta(v.id, v.name);
        }
      } catch {
        // 网络异常时保留本地已知 vault
        Object.assign(merged, cur.vaults);
      }
      persist({ account: acc, vaults: merged });
      const first = Object.values(merged)[0];
      if (first) setVaultId(first.id);
    },
    [persist]
  );

  const onLogin = useCallback(
    async (serverUrl: string, email: string, password: string) => {
      const r = await SyncClient.login(serverUrl, email, password);
      await finishLogin(serverUrl, email, r.user_id, r.access_token, r.refresh_token);
    },
    [finishLogin]
  );

  // ---------- 登录后初始化 ----------

  useEffect(() => {
    if (!client || !vault) return;
    void refreshFiles();
  }, [client, vault?.id, refreshFiles]);

  // 主题切换：html data-theme 属性驱动 CSS 变量
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('ivnote.theme', theme);
  }, [theme]);

  // 移动端：App 回到前台时强制拉取一次（iOS/Android 后台收不到 WS 推送）
  useEffect(() => {
    if (!client) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void doSync();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [client, doSync]);

  // ---------- 文件操作 ----------

  const openFile = useCallback(
    async (path: string) => {
      if (!vault) return;
      try {
        const text = await io.read(vault.localPath ?? '', path);
        setCurrentPath(path);
        setDoc(text);
      } catch (e) {
        alert(`打开失败：${errText(e)}`);
      }
    },
    [vault, io]
  );

  const onEdit = useCallback(
    (path: string, text: string) => {
      if (!vault || path !== currentPath) return;
      setDoc(text);
      // 防抖写盘；真正的推送发生在下一轮 syncVault 扫描（content !== base）
      window.clearTimeout((onEdit as unknown as { t?: number }).t);
      (onEdit as unknown as { t?: number }).t = window.setTimeout(async () => {
        try {
          await io.write(vault.localPath ?? '', path, text);
          void doSync();
        } catch (e) {
          console.error('写盘失败', e);
        }
      }, 800);
    },
    [vault, io, currentPath, doSync]
  );

  const onCreateNote = useCallback(
    async (folder = '') => {
      if (!vault) return;
      const name = window.prompt('笔记文件名（可含子文件夹，如 日记/2026-08-24.md）');
      if (!name) return;
      const rel = `${folder ? folder + '/' : ''}${name.trim().replace(/^\/+|\/+$/g, '')}`;
      if (!/\.md$/i.test(rel)) {
        alert('文件名必须以 .md 结尾');
        return;
      }
      if (files.includes(rel)) {
        alert('同名文件已存在');
        return;
      }
      await io.write(vault.localPath ?? '', rel, `# ${rel.split('/').pop()!.replace(/\.md$/i, '')}\n\n`);
      await refreshFiles();
      void openFile(rel);
      void doSync();
    },
    [vault, files, io, refreshFiles, openFile, doSync]
  );

  const onDeleteFile = useCallback(
    async (path: string) => {
      if (!vault) return;
      if (!window.confirm(`删除 ${path}？（会同步删除到所有设备）`)) return;
      try {
        await io.remove(vault.localPath ?? '', path);
        if (currentPath === path) {
          setCurrentPath(null);
          setDoc(null);
        }
        await refreshFiles();
        void doSync();
      } catch (e) {
        alert(`删除失败：${errText(e)}`);
      }
    },
    [vault, io, currentPath, refreshFiles, doSync]
  );

  // ---------- Obsidian 一键导入 ----------

  const onImportObsidian = useCallback(async () => {
    if (!vault || importing) return;
    setImporting(true);
    try {
      if (isTauri) {
        // 桌面端：选文件夹，递归读取全部 Markdown（跳过 .obsidian 等隐藏目录）
        const { open } = await import('@tauri-apps/plugin-dialog');
        const dir = await open({ directory: true, title: '选择 Obsidian 库文件夹' });
        if (typeof dir !== 'string') return;
        const { readDir, readTextFile } = await import('@tauri-apps/plugin-fs');
        const out: { rel: string; abs: string }[] = [];
        const walk = async (d: string, prefix: string) => {
          for (const e of await readDir(d)) {
            const rel = prefix ? `${prefix}/${e.name}` : e.name;
            if (e.isDirectory) {
              if (!e.name.startsWith('.')) await walk(`${d}/${e.name}`, rel);
            } else if (/\.(md|markdown)$/i.test(e.name)) {
              out.push({ rel, abs: `${d}/${e.name}` });
            }
          }
        };
        await walk(dir, '');
        for (const f of out) {
          await io.write(vault.localPath ?? '', f.rel, await readTextFile(f.abs));
        }
        window.alert(`已从 Obsidian 导入 ${out.length} 个笔记到本地库。\n点「上传」即可同步到服务器。`);
      } else {
        // 浏览器端：优先用目录选择句柄，保留子目录结构；否则退化为文件夹多选
        type DirHandleLike = {
          values(): AsyncIterableIterator<{ kind: string; name: string; getFile(): Promise<File> }>;
        };
        const wdp = (
          window as unknown as { showDirectoryPicker?: () => Promise<DirHandleLike> }
        ).showDirectoryPicker;
        let entries: { rel: string; getText(): Promise<string> }[] = [];
        if (wdp) {
          const root = await wdp.call(window);
          const walk = async (d: DirHandleLike, prefix: string) => {
            for await (const h of d.values()) {
              const rel = prefix ? `${prefix}/${h.name}` : h.name;
              if (h.kind === 'directory') {
                if (!h.name.startsWith('.')) await walk(h as unknown as DirHandleLike, rel);
              } else if (/\.(md|markdown)$/i.test(h.name)) {
                entries.push({ rel, getText: () => h.getFile().then((f) => f.text()) });
              }
            }
          };
          await walk(root, '');
        } else {
          const picked = await new Promise<File[]>((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.multiple = true;
            (input as HTMLInputElement & { webkitdirectory?: boolean }).webkitdirectory = true;
            input.onchange = () => resolve(Array.from(input.files ?? []));
            input.click();
          });
          entries = picked
            .filter((f) => /\.(md|markdown)$/i.test(f.name))
            .map((f) => ({
              rel:
                (f as File & { webkitRelativePath?: string }).webkitRelativePath
                  ?.split('/')
                  .slice(1)
                  .join('/') || f.name,
              getText: () => f.text(),
            }));
        }
        let n = 0;
        for (const e of entries) {
          await io.write(vault.localPath ?? '', e.rel, await e.getText());
          n++;
        }
        window.alert(`已从 Obsidian 导入 ${n} 个笔记。\n点「上传」即可同步到服务器。`);
      }
      await refreshFiles();
    } catch (e) {
      alert(`导入失败：${errText(e)}`);
    } finally {
      setImporting(false);
    }
  }, [vault, importing, io, refreshFiles]);

  // ---------- Vault / 文件夹绑定 ----------

  const createVault = useCallback(async () => {
    if (!client) return;
    const name = window.prompt('新笔记库名称');
    if (!name) return;
    try {
      const v = await client.createVault(name.trim());
      const cur = stateRef.current;
      persist({ ...cur, vaults: { ...cur.vaults, [String(v.id)]: newVaultMeta(v.id, v.name) } });
      setVaultId(v.id);
    } catch (e) {
      alert(`创建失败：${errText(e)}`);
    }
  }, [client, persist]);

  const onBindFolder = useCallback(async () => {
    if (!isTauri) {
      alert('浏览器开发模式下使用内置虚拟存储（OPFS）；绑定真实文件夹请在桌面 App 中进行。');
      return;
    }
    const { open } = await import('@tauri-apps/plugin-dialog');
    const sel = await open({ directory: true });
    if (typeof sel === 'string' && vault) {
      patchVault(vault.id, (m) => {
        m.localPath = sel;
      });
    }
  }, [vault, patchVault]);

  const onUnbindFolder = useCallback(() => {
    if (!vault) return;
    patchVault(vault.id, (m) => {
      m.localPath = undefined;
    });
  }, [vault, patchVault]);

  const onLogout = useCallback(() => {
    clearState();
    setState({ vaults: {} });
    setVaultId(null);
    setCurrentPath(null);
    setDoc(null);
    setFiles([]);
  }, []);

  // ---------- 渲染 ----------

  if (!state.account || !client) {
    return showGuide ? (
      <SetupGuide onBack={() => setShowGuide(false)} />
    ) : (
      <LoginView onLogin={onLogin} onShowGuide={() => setShowGuide(true)} />
    );
  }

  const vaultList = Object.values(state.vaults);
  const isMobile = useIsMobile();

  const vaultSelectorEl = (value: number | '', onChange: (id: number) => void) => (
    <select
      value={value}
      onChange={(e) => {
        if (e.target.value) onChange(Number(e.target.value));
      }}
    >
      {value === '' && <option value="">选择一个笔记库…</option>}
      {vaultList.map((v) => (
        <option key={v.id} value={v.id}>
          {v.name}
        </option>
      ))}
    </select>
  );

  if (isMobile && vault) {
    return (
      <div className="app">
        <MobileView
          vault={vault}
          files={files}
          currentPath={currentPath}
          doc={doc}
          syncing={syncing}
          lastReport={lastReport}
          vaultSelector={vaultSelectorEl(vaultId ?? '', (id) => {
            setVaultId(id);
            setCurrentPath(null);
            setDoc(null);
          })}
          onSelect={(p) => void openFile(p)}
          onEdit={onEdit}
          onCreateNote={() => void onCreateNote('')}
          onDeleteFile={(p) => void onDeleteFile(p)}
          onSync={() => void doSync()}
          onCreateVault={createVault}
          theme={theme}
          onToggleTheme={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          onLogout={onLogout}
        />
      </div>
    );
  }

  if (!vault) {
    return (
      <div className="app">
        <MainView
          vault={{ id: -1, name: 'Ivyea Note', cursor: 0, versions: {}, bases: {} }}
          files={[]}
          currentPath={null}
          doc={null}
          syncing={false}
          lastReport={null}
          onSelect={() => undefined}
          onEdit={() => undefined}
          onCreateNote={() => undefined}
          onNewFolderNote={() => undefined}
          onDeleteFile={() => undefined}
          onUpload={() => undefined}
          onDownload={() => undefined}
          onImportObsidian={() => undefined}
          theme={theme}
          onToggleTheme={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          onBindFolder={() => undefined}
          onUnbindFolder={() => undefined}
          onLogout={onLogout}
          vaultSelector={
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) setVaultId(Number(e.target.value));
              }}
            >
              <option value="">选择一个笔记库…</option>
              {vaultList.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          }
          onCreateVault={createVault}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <MainView
        vault={vault}
        files={files}
        currentPath={currentPath}
        doc={doc}
        syncing={syncing}
        lastReport={lastReport}
        onSelect={(p) => void openFile(p)}
        onEdit={onEdit}
        onCreateNote={() => void onCreateNote('')}
        onNewFolderNote={(folder) => void onCreateNote(folder)}
        onDeleteFile={(p) => void onDeleteFile(p)}
        onUpload={() => void doUpload()}
        onDownload={() => void doDownload()}
        onImportObsidian={() => void onImportObsidian()}
        theme={theme}
        onToggleTheme={() => setTheme(theme === 'light' ? 'dark' : 'light')}
        onBindFolder={() => void onBindFolder()}
        onUnbindFolder={onUnbindFolder}
        onLogout={onLogout}
        vaultSelector={
          <select
            value={vaultId ?? ''}
            onChange={(e) => {
              setVaultId(Number(e.target.value));
              setCurrentPath(null);
              setDoc(null);
            }}
          >
            {vaultList.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        }
        onCreateVault={createVault}
      />
    </div>
  );
}

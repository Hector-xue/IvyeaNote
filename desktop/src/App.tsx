import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LoginView } from './ui/LoginView';
import { SetupGuide } from './ui/SetupGuide';
import { MainView, type SortMode } from './ui/MainView';
import { MobileView } from './ui/MobileView';
import { useDialog } from './ui/Dialog';
import { useToast } from './ui/Toast';
import { ApiError, SyncClient } from './lib/api';
import { syncVault, pushOnly, pullOnly, type FileIO, type FileMeta, type SyncReport } from './lib/sync';
import { tauriIO, opfsIO, migrateFiles } from './lib/fs-adapters';
import {
  loadState,
  saveState,
  clearAccount,
  ensureLocalVault,
  mergeLocalIntoCloud,
  LOCAL_VAULT_ID,
  LOCAL_VAULT_NAME,
  newVaultMeta,
  type PersistState,
  type VaultMeta,
} from './lib/store';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);

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

/** 排序偏好持久化 */
function loadSortMode(): SortMode {
  return (localStorage.getItem('ivnote.sort') as SortMode) || 'name';
}

export default function App() {
  // 免登录本地模式：无账号时初始化即带一个「我的笔记」本地库
  const [state, setState] = useState<PersistState>(() => {
    const s = loadState();
    return s.account ? s : ensureLocalVault(s);
  });
  const [vaultId, setVaultId] = useState<number | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  /** v0.3.4：PDF 列表与元数据（排序） */
  const [pdfs, setPdfs] = useState<string[]>([]);
  const metasRef = useRef<Map<string, FileMeta>>(new Map());
  const [sortMode, setSortMode] = useState<SortMode>(() => loadSortMode());
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [doc, setDoc] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [lastReport, setLastReport] = useState<SyncReport | null>(null);
  const [importing, setImporting] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  /** 按需唤起的登录页（免登录模式下从侧栏打开） */
  const [showLogin, setShowLogin] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(
    () => (localStorage.getItem('ivnote.theme') as 'light' | 'dark') || 'light'
  );
  /** v0.3.4：桌面端 PDF 内嵌预览（object URL） */
  const [pdfView, setPdfView] = useState<string | null>(null);
  const pdfUrlRef = useRef<string | null>(null);
  /** v0.3.4：阅读模式图片 blob URL 缓存 */
  const imgCache = useRef<Map<string, string>>(new Map());

  const stateRef = useRef(state);
  stateRef.current = state;
  const syncingRef = useRef(false);

  // ---- v0.3.3：全部 hooks 必须在任何条件 return 之前调用（修复 Rules of Hooks 违例）----
  const isMobile = useIsMobile();
  /** 应用内对话框：替代 window.prompt/confirm（WebView2 不支持 prompt，静默返回 null） */
  const { prompt, confirm, dialogEl } = useDialog();
  /** 轻提示：替代 window.alert（安卓 WebView 里 alert 阻塞且割裂） */
  const { toast, toastEl } = useToast();
  /** 编辑防抖计时器：替代旧的「函数对象挂属性」写法（重构即坏、类型不安全） */
  const saveTimer = useRef<number | undefined>(undefined);

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

  // 未登录时强制使用本地库（免登录模式的主界面）
  const activeVaultId = state.account ? vaultId : LOCAL_VAULT_ID;
  const vault: VaultMeta | null = activeVaultId ? state.vaults[String(activeVaultId)] ?? null : null;

  // 文件 IO：绑定了本地文件夹且在 Tauri 里 → 真实磁盘；否则 OPFS
  const io: FileIO = useMemo(() => {
    const vp = vault?.localPath;
    // 'opfs://' 前缀是虚拟标记（本地库 / 移动端未绑定文件夹），统一走 OPFS
    if (vp && isTauri && !vp.startsWith('opfs://')) return tauriIO;
    return opfsIO(() => {
      const m = stateRef.current.vaults[String(vaultId ?? '')];
      return m ?? newVaultMeta(-1, 'tmp');
    });
  }, [vault?.localPath, vaultId]);

  /** v0.3.4：按当前排序方式整理文件列表 */
  const applySort = useCallback((list: string[]): string[] => {
    const metas = metasRef.current;
    if (sortMode === 'mtime') {
      return [...list].sort((a, b) => (metas.get(b)?.mtime ?? 0) - (metas.get(a)?.mtime ?? 0));
    }
    return [...list].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  }, [sortMode]);

  const refreshFiles = useCallback(async () => {
    if (!vault) return;
    try {
      // v0.3.4：listMeta 一次拿路径+修改时间+大小
      const metas = await io.listMeta(vault.localPath ?? '');
      metasRef.current = new Map(metas.map((m) => [m.path, m]));
      const all = metas.map((m) => m.path);
      setFiles(applySort(all.filter((p) => /\.md$/i.test(p))));
      setPdfs(applySort(all.filter((p) => /\.pdf$/i.test(p))));
    } catch (e) {
      console.error('列出文件失败', e);
    }
  }, [vault, io, applySort]);

  const onSortChange = useCallback(
    (m: SortMode) => {
      setSortMode(m);
      localStorage.setItem('ivnote.sort', m);
      setFiles((cur) => applySort(cur));
      setPdfs((cur) => applySort(cur));
    },
    [applySort]
  );

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
      const localV = cur.vaults[String(LOCAL_VAULT_ID)];
      // 拉取服务端 vault 列表并合并（保留本地已有元数据）
      const merged: Record<string, VaultMeta> = {};
      let firstId: number | null = null;
      // 免登录期本地库的数据源：绑定了真实文件夹用磁盘，否则 OPFS
      const localReal = !!localV?.localPath && !localV.localPath.startsWith('opfs://');
      const srcIo =
        localV && localReal
          ? tauriIO
          : opfsIO(() => localV ?? newVaultMeta(LOCAL_VAULT_ID, LOCAL_VAULT_NAME));
      const srcPath = localV && localReal ? localV.localPath! : '';
      try {
        const c = new SyncClient(serverUrl, acc.tokens, () => undefined, deviceId);
        const { vaults } = await c.listVaults();
        for (const v of vaults) {
          merged[String(v.id)] = cur.vaults[String(v.id)] ?? newVaultMeta(v.id, v.name);
        }
        if (localV && vaults.length === 0) {
          // 云端还是空的：把本地库直接升级为云端第一个库（笔记复制过去）
          try {
            const created = await c.createVault(LOCAL_VAULT_NAME);
            merged[String(created.id)] = {
              id: created.id,
              name: LOCAL_VAULT_NAME,
              cursor: 0,
              versions: {},
              bases: {},
              tombstones: {},
            };
            await migrateFiles(srcIo, srcPath, opfsIO(() => merged[String(created.id)]!), '');
            firstId = created.id;
          } catch {
            merged[String(LOCAL_VAULT_ID)] = localV; // 迁移失败：保留纯本地库，笔记不丢
          }
        } else if (localV && vaults.length > 0) {
          // 云端已有库：把本地笔记并入最旧的云端库
          const target = Object.values(merged).sort((a, b) => a.id - b.id)[0];
          if (target) {
            try {
              const dstPath = target.localPath ?? '';
              const dstIo =
                dstPath && !dstPath.startsWith('opfs://') ? tauriIO : opfsIO(() => target);
              await migrateFiles(srcIo, srcPath, dstIo, dstPath, localV.tombstones);
              merged[String(target.id)] = mergeLocalIntoCloud(localV, target);
              firstId = target.id;
            } catch {
              merged[String(LOCAL_VAULT_ID)] = localV; // 复制失败：保留本地库
            }
          }
        }
      } catch {
        // 网络异常时保留本地已知 vault（含未迁移的本地库）
        Object.assign(merged, cur.vaults);
      }
      persist({ account: acc, vaults: merged });
      setVaultId(firstId ?? Object.values(merged)[0]?.id ?? null);
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

  // v0.3.3：文件列表只依赖 vault，不再被 client 门控 ——
  // 免登录本地模式下（client 为 null）也能立刻列出本地库文件。
  useEffect(() => {
    if (!vault) return;
    void refreshFiles();
  }, [vault, refreshFiles]);

  // 主题切换：html data-theme 属性驱动 CSS 变量
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('ivnote.theme', theme);
  }, [theme]);

  // 免登录本地模式：确保本地库存在并落盘（老用户首次升级也生效）
  useEffect(() => {
    if (!stateRef.current.account) persist(ensureLocalVault());
  }, [persist]);

  // 移动端：App 回到前台时强制拉取一次（iOS/Android 后台收不到 WS 推送）
  useEffect(() => {
    if (!client) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void doSync();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [client, doSync]);

  // 卸载时清理编辑防抖计时器
  useEffect(() => () => window.clearTimeout(saveTimer.current), []);

  // ---------- 文件操作 ----------

  const openFile = useCallback(
    async (path: string) => {
      if (!vault) return;
      try {
        const text = await io.read(vault.localPath ?? '', path);
        setPdfView(null);
        setCurrentPath(path);
        setDoc(text);
      } catch (e) {
        toast(`打开失败：${errText(e)}`, 'error');
      }
    },
    [vault, io, toast]
  );

  const onEdit = useCallback(
    (path: string, text: string) => {
      if (!vault || path !== currentPath) return;
      setDoc(text);
      // 防抖写盘；真正的推送发生在下一轮 syncVault 扫描（content !== base）
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(async () => {
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
      const relOf = (name: string) =>
        `${folder ? folder + '/' : ''}${name.trim().replace(/^\/+|\/+$/g, '')}`;
      // v0.3.3：应用内对话框替代 window.prompt（WebView2 下 prompt 静默返回 null，按钮形同虚设）
      const name = await prompt({
        title: '新建笔记',
        description: '文件名可含子文件夹，如 日记/2026-08-24.md',
        placeholder: '例：日记/2026-08-24.md',
        okText: '创建',
        validate: (v) => {
          if (!v.trim()) return '请输入文件名';
          const rel = relOf(v);
          if (!/\.md$/i.test(rel)) return '文件名必须以 .md 结尾';
          if (files.includes(rel)) return '同名文件已存在';
          return null;
        },
      });
      if (!name) return;
      const rel = relOf(name);
      await io.write(vault.localPath ?? '', rel, `# ${rel.split('/').pop()!.replace(/\.md$/i, '')}\n\n`);
      await refreshFiles();
      void openFile(rel);
      void doSync();
    },
    [vault, files, io, refreshFiles, openFile, doSync, prompt]
  );

  const onDeleteFile = useCallback(
    async (path: string) => {
      if (!vault) return;
      // v0.3.3：应用内确认框替代 window.confirm（安卓 WebView 行为统一）
      const ok = await confirm({
        title: '删除笔记',
        description: `删除 ${path}？（会同步删除到所有设备）`,
        okText: '删除',
        danger: true,
      });
      if (!ok) return;
      try {
        await io.remove(vault.localPath ?? '', path);
        if (currentPath === path) {
          setCurrentPath(null);
          setDoc(null);
        }
        await refreshFiles();
        void doSync();
      } catch (e) {
        toast(`删除失败：${errText(e)}`, 'error');
      }
    },
    [vault, io, currentPath, refreshFiles, doSync, confirm, toast]
  );

  // ---------- v0.3.4：插图 / 图片解析 / PDF ----------

  /** 选一张图片 → 拷入 Attachments/ → 返回相对路径（null=取消） */
  const onInsertImage = useCallback(async (): Promise<string | null> => {
    if (!vault) return null;
    let picked: { name: string; data: Uint8Array }[] = [];
    if (isTauri) {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const { readFile } = await import('@tauri-apps/plugin-fs');
      const sel = await open({ multiple: true, title: '选择图片' });
      const paths = Array.isArray(sel) ? sel : sel ? [sel] : [];
      for (const p of paths) {
        if (typeof p !== 'string') continue;
        const data = await readFile(p);
        picked.push({ name: p.split(/[\\/]/).pop() ?? 'image.png', data });
      }
    } else {
      const filesPicked = await new Promise<File[]>((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = () => resolve(Array.from(input.files ?? []));
        input.click();
      });
      for (const f of filesPicked) {
        picked.push({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
      }
    }
    if (picked.length === 0) return null;
    const first = picked[0];
    // 目标名：Attachments/时间戳-原名，重名加序号
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    let rel = `Attachments/${stamp}-${first.name.replace(/[\\/]/g, '_')}`;
    let i = 1;
    while (await io.exists(vault.localPath ?? '', rel).catch(() => false)) {
      rel = rel.replace(/(\.[a-z0-9]+)$/i, `-${i}$1`);
      i++;
    }
    await io.writeBinary(vault.localPath ?? '', rel, first.data);
    await refreshFiles();
    void doSync();
    return rel;
  }, [vault, io, refreshFiles, doSync]);

  /** 阅读模式：把 Markdown 里的相对图片路径解析成可显示的 blob URL */
  const resolveImage = useCallback(
    async (rel: string): Promise<string | null> => {
      if (!vault) return null;
      const cached = imgCache.current.get(rel);
      if (cached) return cached;
      const bytes = await io.readBinary(vault.localPath ?? '', rel);
      const ext = rel.split('.').pop()?.toLowerCase() ?? 'png';
      const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : `image/${ext}`;
      const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mime }));
      imgCache.current.set(rel, url);
      return url;
    },
    [vault, io]
  );

  /** 打开 PDF：桌面/浏览器内嵌预览；安卓交给系统应用 */
  const onOpenPdf = useCallback(
    async (path: string) => {
      if (!vault) return;
      if (isAndroid && vault.localPath && !vault.localPath.startsWith('opfs://')) {
        try {
          const { openPath } = await import('@tauri-apps/plugin-opener');
          await openPath(`${vault.localPath.replace(/\/$/, '')}/${path}`);
          return;
        } catch (e) {
          toast(`无法打开 PDF：${errText(e)}`, 'error');
          return;
        }
      }
      try {
        const bytes = await io.readBinary(vault.localPath ?? '', path);
        if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
        const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' }));
        pdfUrlRef.current = url;
        setCurrentPath(null);
        setDoc(null);
        setPdfView(url);
      } catch (e) {
        toast(`打开 PDF 失败：${errText(e)}`, 'error');
      }
    },
    [vault, io, toast]
  );

  const onClosePdf = useCallback(() => {
    if (pdfUrlRef.current) {
      URL.revokeObjectURL(pdfUrlRef.current);
      pdfUrlRef.current = null;
    }
    setPdfView(null);
  }, []);

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
        toast(`已从 Obsidian 导入 ${out.length} 个笔记到本地库，点「上传」即可同步到服务器`, 'ok');
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
        toast(`已从 Obsidian 导入 ${n} 个笔记，点「上传」即可同步到服务器`, 'ok');
      }
      await refreshFiles();
    } catch (e) {
      toast(`导入失败：${errText(e)}`, 'error');
    } finally {
      setImporting(false);
    }
  }, [vault, importing, io, refreshFiles, toast]);

  // ---------- Vault / 文件夹绑定 ----------

  const createVault = useCallback(async () => {
    if (!client) {
      toast('云同步需要登录：请先在侧栏点「登录同步」');
      return;
    }
    const name = await prompt({
      title: '新建笔记库',
      placeholder: '笔记库名称',
      okText: '创建',
      validate: (v) => (v.trim() ? null : '请输入名称'),
    });
    if (!name) return;
    try {
      const v = await client.createVault(name.trim());
      const cur = stateRef.current;
      persist({ ...cur, vaults: { ...cur.vaults, [String(v.id)]: newVaultMeta(v.id, v.name) } });
      setVaultId(v.id);
    } catch (e) {
      toast(`创建失败：${errText(e)}`, 'error');
    }
  }, [client, persist, prompt, toast]);

  const onBindFolder = useCallback(async () => {
    if (!isTauri) {
      toast('浏览器开发模式下使用内置虚拟存储（OPFS）；绑定真实文件夹请在桌面 App 中进行。');
      return;
    }
    const { open } = await import('@tauri-apps/plugin-dialog');
    const sel = await open({ directory: true });
    if (typeof sel === 'string' && vault) {
      patchVault(vault.id, (m) => {
        m.localPath = sel;
      });
    }
  }, [vault, patchVault, toast]);

  const onUnbindFolder = useCallback(() => {
    if (!vault) return;
    patchVault(vault.id, (m) => {
      m.localPath = undefined;
    });
  }, [vault, patchVault]);

  const onLogout = useCallback(() => {
    // 只清登录态，保留全部本地笔记（含免登录本地库），下次登录可继续迁移
    clearAccount();
    setState((s) => ({ ...s, account: undefined }));
    setShowLogin(false);
    setCurrentPath(null);
    setDoc(null);
    setFiles([]);
    setPdfs([]);
    setLastReport(null);
  }, []);

  // ---------- 渲染 ----------

  // 登录页只在用户主动唤起且尚未登录时显示；平时无账号也直达主界面（本地模式）
  // 注意：此处 early return 之前所有 hooks 均已调用完毕（v0.3.3 修复 Rules of Hooks 违例）
  if (!state.account && showLogin) {
    return showGuide ? (
      <SetupGuide onBack={() => setShowGuide(false)} />
    ) : (
      <LoginView
        onLogin={onLogin}
        onShowGuide={() => setShowGuide(true)}
        onCancel={() => setShowLogin(false)}
      />
    );
  }

  // 未登录：列表里只展示本地库（云端库要登录后才能用）
  const vaultList = Object.values(state.vaults).filter((v) => state.account || v.id === LOCAL_VAULT_ID);

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
          pdfs={pdfs}
          currentPath={currentPath}
          doc={doc}
          syncing={syncing}
          lastReport={lastReport}
          vaultSelector={vaultSelectorEl(activeVaultId ?? '', (id) => {
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
          hasAccount={!!state.account}
          onOpenLogin={() => setShowLogin(true)}
          syncDisabled={!state.account}
          sortMode={sortMode}
          onSortChange={onSortChange}
          onOpenPdf={(p) => void onOpenPdf(p)}
          onInsertImage={onInsertImage}
          resolveImage={resolveImage}
        />
        {dialogEl}
        {toastEl}
      </div>
    );
  }

  if (!vault) {
    return (
      <div className="app">
        <MainView
          vault={{ id: -1, name: 'Ivyea Note', cursor: 0, versions: {}, bases: {} }}
          files={[]}
          pdfs={[]}
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
          hasAccount={!!state.account}
          onOpenLogin={() => setShowLogin(true)}
          syncDisabled={!state.account}
          sortMode={sortMode}
          onSortChange={onSortChange}
          onOpenPdf={() => undefined}
          pdfView={null}
          onClosePdf={onClosePdf}
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
        {dialogEl}
        {toastEl}
      </div>
    );
  }

  return (
    <div className="app">
      <MainView
        vault={vault}
        files={files}
        pdfs={pdfs}
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
        hasAccount={!!state.account}
        onOpenLogin={() => setShowLogin(true)}
        syncDisabled={!state.account}
        sortMode={sortMode}
        onSortChange={onSortChange}
        onOpenPdf={(p) => void onOpenPdf(p)}
        pdfView={pdfView}
        onClosePdf={onClosePdf}
        onInsertImage={onInsertImage}
        resolveImage={resolveImage}
        vaultSelector={
          <select
            value={activeVaultId ?? ''}
            onChange={(e) => {
              setVaultId(Number(e.target.value));
              setCurrentPath(null);
              setDoc(null);
              setPdfView(null);
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
      {dialogEl}
      {toastEl}
    </div>
  );
}

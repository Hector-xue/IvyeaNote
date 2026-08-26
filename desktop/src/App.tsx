import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LoginView } from './ui/LoginView';
import { SetupGuide } from './ui/SetupGuide';
import { MainView, type SortMode } from './ui/MainView';
import { MobileView } from './ui/MobileView';
import { useDialog } from './ui/Dialog';
// v0.7.2：应用内更新
import { checkForUpdate, installUpdate, openReleasePage, type UpdateInfo } from './lib/updater';
import { useToast } from './ui/Toast';
import { WelcomeView, isWelcomed } from './ui/WelcomeView';
import { ApiError, SyncClient } from './lib/api';
import { syncVault, pushOnly, pullOnly, type FileIO, type FileMeta, type SyncReport } from './lib/sync';
import { tauriIO, opfsIO, migrateFiles } from './lib/fs-adapters';
import { extractH1, titleToPath, uniqueName, sanitizeTitle } from './lib/titleSync';
import { loadCollapsed, saveCollapsed } from './ui/FileTree';
import { Palette, type PaletteMode, type CommandItem } from './ui/Palette';
import { GraphView } from './ui/GraphView';
import type { SearchDoc } from './lib/searchIndex';
import { extractLinks, titleOfPath } from './lib/wikilink';
import { buildTagIndex } from './lib/tags';
import { todayPath, dailyContent, templateFiles, renderTemplate } from './lib/daily';
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
  /** v0.4.0 T2：首启引导（仅未登录且首次启动显示） */
  const [showWelcome, setShowWelcome] = useState(() => !isWelcomed());
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

  // ---- v0.7.2：应用内更新 ----
  /** 当前版本：构建时由 vite define 注入（取自 tauri.conf.json），兜底 0.0.0 */
  const appVersion = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
  const [pendingUpdate, setPendingUpdate] = useState<UpdateInfo | null>(null);
  const [updating, setUpdating] = useState(false);
  void updating; // 预留：后续接入下载进度 UI
  /** 手动「检查更新」时置 true，用于区分静默检查（无更新不提示） */
  const manualCheckRef = useRef(false);
  /** 是否移动端（Android）：更新走跳转下载而非应用内安装 */
  const isMobileDevice = /android|iphone|ipad/i.test(navigator.userAgent);

  /** 检查更新并弹 Dialog；silent=true 时无更新不打扰 */
  const runUpdateCheck = useCallback(
    async (silent: boolean) => {
      manualCheckRef.current = !silent;
      try {
        const info = await checkForUpdate(appVersion);
        const dismissed = localStorage.getItem('ivnote.update.dismissed');
        if (info && !(silent && info.version === dismissed)) {
          setPendingUpdate(info);
        } else if (!silent) {
          toast(`已是最新版本（v${appVersion}）`, 'ok');
        }
      } catch {
        if (!silent) toast('检查更新失败，请稍后重试或到 GitHub Releases 查看', 'error');
      }
    },
    [appVersion, toast]
  );

  // 启动后延迟 3 秒静默检查一次（避免抢启动带宽/焦点）
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    const t = window.setTimeout(() => void runUpdateCheck(true), 3000);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 发现新版本时弹确认框（用户点「忽略此版本」后，同版本静默检查不再打扰）
  useEffect(() => {
    if (!pendingUpdate) return;
    void (async () => {
      const ok = await confirm({
        title: `发现新版本 v${pendingUpdate.version}`,
        description: isMobileDevice
          ? `当前版本 v${appVersion}。安卓端请在浏览器中下载新 APK 安装。`
          : `当前版本 v${appVersion}。更新将自动下载并重启应用。`,
        okText: isMobileDevice ? '前往下载' : '立即更新',
        cancelText: '忽略此版本',
      });
      if (ok) {
        dismissUpdate();
        await applyUpdate();
      } else {
        dismissUpdate();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingUpdate]);

  /** 确认更新：桌面走 updater 插件下载安装重启；Android 跳 Release 页 */
  const applyUpdate = useCallback(async () => {
    if (!pendingUpdate) return;
    if (isMobileDevice) {
      await openReleasePage();
      return;
    }
    setUpdating(true);
    try {
      toast('正在下载更新…', 'ok');
      await installUpdate();
      // installUpdate 内部会 relaunch，正常不会走到这里
    } catch {
      setUpdating(false);
      toast('更新失败，可到 GitHub Releases 手动下载', 'error');
    }
  }, [pendingUpdate, isMobileDevice, toast]);

  /** 忽略此版本（记 localStorage，之后不再自动提示） */
  const dismissUpdate = useCallback(() => {
    if (pendingUpdate) {
      localStorage.setItem('ivnote.update.dismissed', pendingUpdate.version);
    }
    setPendingUpdate(null);
  }, [pendingUpdate]);

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
      // v0.4.0 T5：.trash/ 回收站目录不进主列表
      const all = metas.map((m) => m.path).filter((p) => !p.startsWith('.trash/'));
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

  /** v0.6.1 H6：配对码登录（token 注入，免密码） */
  const onPairLogin = useCallback(
    async (serverUrl: string, userId: number, access: string, refresh: string) => {
      await finishLogin(serverUrl, `paired-user-${userId}`, userId, access, refresh);
    },
    [finishLogin]
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

  // v0.6.1 H7a：全自动同步——启动后 2s / 窗口聚焦 / 每 60s 兜底轮询。
  // 编辑落盘后的推送已在 onEdit 防抖里触发，这里补齐其余时机；
  // doSync 内部有 syncingRef 重入保护，多时机并发安全。
  useEffect(() => {
    if (!client) return;
    const timer = window.setTimeout(() => void doSync(), 2000); // 启动拉取一次
    const onVisible = () => {
      if (document.visibilityState === 'visible') void doSync();
    };
    document.addEventListener('visibilitychange', onVisible);
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') void doSync();
    }, 60_000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
    };
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

  /**
   * v0.4.0 T3：标题跟随——编辑防抖落盘后，若正文首个 H1 与当前文件名不一致，
   * 自动把文件重命名为标题（同目录内、清洗非法字符）。
   * 同步层把改名表达为「新路径 upsert + 旧路径 delete」，多端自然收敛。
   */
  const maybeRenameToH1 = useCallback(
    async (path: string, text: string) => {
      if (!vault || !/\.md$/i.test(path)) return;
      const h1 = extractH1(text);
      if (!h1) return;
      const target = titleToPath(path, h1);
      if (target === path) return;
      try {
        if (await io.exists(vault.localPath ?? '', target)) return; // 目标已存在：不抢名
        await io.write(vault.localPath ?? '', target, text);
        await io.remove(vault.localPath ?? '', path);
        setCurrentPath(target);
        setDoc(text);
        await refreshFiles();
        toast(`已按标题重命名：${path.split('/').pop()} → ${target.split('/').pop()}`, 'ok');
        void doSync();
      } catch {
        // 改名失败不影响编辑主流程
      }
    },
    [vault, io, refreshFiles, doSync, toast]
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
          // v0.4.0：标题跟随（在写盘之后执行，避免和防抖写盘竞争）
          void maybeRenameToH1(path, text);
        } catch (e) {
          console.error('写盘失败', e);
        }
      }, 800);
    },
    [vault, io, currentPath, doSync, maybeRenameToH1]
  );

  /**
   * v0.4.0 T3：Obsidian 式即时新建——不再弹框要名字，
   * 直接创建 untitled.md（重名自动序号）并进入编辑态。
   * 标题由用户在正文 H1 里写，文件名自动跟随（见 renameToTitleEffect）。
   */
  const onCreateNote = useCallback(
    async (folder = '') => {
      if (!vault) return;
      const prefix = folder ? `${folder.replace(/\/+$/, '')}/` : '';
      const base = uniqueName(
        'untitled',
        files.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length))
      );
      const rel = `${prefix}${base}`;
      await io.write(vault.localPath ?? '', rel, '# untitled\n\n');
      await refreshFiles();
      void openFile(rel);
      void doSync();
    },
    [vault, files, io, refreshFiles, openFile, doSync]
  );

  /** v0.5.0 U3：文件夹折叠状态（持久化） */
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => loadCollapsed());
  const toggleDir = useCallback((dir: string) => {
    setCollapsedDirs((s) => {
      const n = new Set(s);
      if (n.has(dir)) n.delete(dir);
      else n.add(dir);
      saveCollapsed(n);
      return n;
    });
  }, []);

  /** v0.5.0 U3：新建文件夹 */
  const onCreateFolder = useCallback(
    async (parent = '') => {
      if (!vault) return;
      const name = await prompt({
        title: '新建文件夹',
        placeholder: parent ? `${parent}/文件夹名` : '文件夹名',
        okText: '创建',
        validate: (v) => {
          const t = sanitizeTitle(v, '');
          if (!t) return '请输入文件夹名';
          const full = parent ? `${parent}/${t}` : t;
          if (files.some((f) => f.startsWith(full + '/'))) return '同名文件夹已存在';
          return null;
        },
      });
      if (!name) return;
      const full = `${parent ? parent + '/' : ''}${sanitizeTitle(name, '未命名')}`;
      try {
        // 空文件夹用一个占位文件保证目录存在（Obsidian 同款做法的简化版）
        await io.write(vault.localPath ?? '', `${full}/.keep`, '');
        await refreshFiles();
        void doSync();
      } catch (e) {
        toast(`创建失败：${errText(e)}`, 'error');
      }
    },
    [vault, io, files, refreshFiles, doSync, prompt, toast]
  );

  /** v0.5.0 U2：多标签页（打开的笔记路径列表 + 当前激活），持久化 */
  const [openTabs, setOpenTabs] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('ivnote.tabs') ?? '[]') as string[];
    } catch {
      return [];
    }
  });
  const [activeTab, setActiveTab] = useState<string | null>(
    () => localStorage.getItem('ivnote.activeTab')
  );
  useEffect(() => {
    localStorage.setItem('ivnote.tabs', JSON.stringify(openTabs));
    if (activeTab) localStorage.setItem('ivnote.activeTab', activeTab);
    else localStorage.removeItem('ivnote.activeTab');
  }, [openTabs, activeTab]);

  /** 打开笔记：确保标签存在并激活（包装 openFile） */
  const openFileInTab = useCallback(
    async (path: string) => {
      setOpenTabs((tabs) => (tabs.includes(path) ? tabs : [...tabs, path]));
      setActiveTab(path);
      await openFile(path);
    },
    [openFile]
  );

  /** 关闭标签：若是当前标签则切到相邻标签 */
  const closeTab = useCallback(
    (path: string) => {
      setOpenTabs((tabs) => {
        const idx = tabs.indexOf(path);
        const next = tabs.filter((t) => t !== path);
        setActiveTab((cur) => {
          if (cur !== path) return cur;
          const fallback = next[Math.min(idx, next.length - 1)] ?? null;
          if (fallback) void openFile(fallback);
          else {
            setCurrentPath(null);
            setDoc(null);
          }
          return fallback;
        });
        return next;
      });
    },
    [openFile]
  );

  /** v0.7.3 P1：重命名笔记（移动端长按菜单；同名冲突自动序号） */
  const onRenameFile = useCallback(
    async (path: string, newNameRaw: string) => {
      if (!vault || !/\.md$/i.test(path)) return;
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
      let base = newNameRaw.trim().replace(/\\/g, '/').replaceAll('/', '');
      if (!base) return;
      base = base.replace(/\.(md|markdown)$/i, '') + '.md';
      const target = `${dir}${base}`;
      if (target === path) return;
      try {
        let final = target;
        if (await io.exists(vault.localPath ?? '', final)) {
          // 目标已存在：自动序号 -2、-3…
          const stem = base.replace(/\.md$/i, '');
          let i = 2;
          while (await io.exists(vault.localPath ?? '', `${dir}${stem}-${i}.md`).catch(() => false)) i++;
          final = `${dir}${stem}-${i}.md`;
        }
        const content = await io.read(vault.localPath ?? '', path);
        await io.write(vault.localPath ?? '', final, content);
        await io.remove(vault.localPath ?? '', path);
        if (currentPath === path) setCurrentPath(final);
        await refreshFiles();
        void doSync();
        toast(`已重命名：${titleOfPath(path)} → ${titleOfPath(final)}`, 'ok');
      } catch (e) {
        toast(`重命名失败：${errText(e)}`, 'error');
      }
    },
    [vault, io, currentPath, refreshFiles, doSync, toast]
  );

  const onDeleteFile = useCallback(
    async (path: string) => {
      if (!vault) return;
      // v0.3.3：应用内确认框替代 window.confirm（安卓 WebView 行为统一）
      const ok = await confirm({
        title: '删除笔记',
        description: `「${path}」将移入回收站，可在回收站恢复。`,
        okText: '删除',
        danger: true,
      });
      if (!ok) return;
      try {
        // v0.4.0 T5：移入回收站而非直接物理删除
        // v0.5.0：目录结构编码进文件名（sub/b.md → sub__b.md），恢复时可还原
        const base = path.replaceAll('/', '__');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        let trashRel = `.trash/${stamp}-${base}`;
        while (await io.exists(vault.localPath ?? '', trashRel).catch(() => false)) {
          trashRel = trashRel.replace(/(\.md)$/i, `-1$1`);
        }
        const content = await io.read(vault.localPath ?? '', path);
        await io.write(vault.localPath ?? '', trashRel, content);
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

  /**
   * v0.4.0 T5：回收站。
   * 列出 .trash/ 下全部条目；支持恢复（移回原目录）与彻底删除。
   */
  const [trashList, setTrashList] = useState<string[]>([]);
  const [showTrash, setShowTrash] = useState(false);

  const openTrash = useCallback(async () => {
    if (!vault) return;
    try {
      const all = (await io.list(vault.localPath ?? '')).filter((p) => p.startsWith('.trash/'));
      setTrashList(all);
      setShowTrash(true);
    } catch (e) {
      toast(`读取回收站失败：${errText(e)}`, 'error');
    }
  }, [vault, io, toast]);

  const restoreFromTrash = useCallback(
    async (trashPath: string) => {
      if (!vault) return;
      // 文件名格式：时间戳-原路径（目录用 __ 编码）→ 还原完整相对路径
      const base = trashPath.split('/').pop() ?? '';
      const original = base.replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, '').replaceAll('__', '/');
      try {
        if (await io.exists(vault.localPath ?? '', original)) {
          toast(`恢复失败：${original} 已存在同名笔记`, 'error');
          return;
        }
        const content = await io.read(vault.localPath ?? '', trashPath);
        await io.write(vault.localPath ?? '', original, content);
        await io.remove(vault.localPath ?? '', trashPath);
        setTrashList((l) => l.filter((p) => p !== trashPath));
        await refreshFiles();
        void doSync();
        toast(`已恢复：${original}`, 'ok');
      } catch (e) {
        toast(`恢复失败：${errText(e)}`, 'error');
      }
    },
    [vault, io, refreshFiles, doSync, toast]
  );

  /** v0.6.1 H7c：冲突待处理队列（conflict 副本路径列表，从最近同步报告收集） */
  const [showConflict, setShowConflict] = useState(false);
  /** v0.6.1 H6: add-device pairing code dialog */
  const [pairInfo, setPairInfo] = useState<{ code: string; expiresIn: number } | null>(null);
  const [pairBusy, setPairBusy] = useState(false);
  /** v0.7.0 F1/F2: universal palette (search / switcher / commands) */
  const [paletteMode, setPaletteMode] = useState<PaletteMode | null>(null);
  const [searchDocs, setSearchDocs] = useState<SearchDoc[]>([]);
  /** v0.7.0 F4: tags panel */
  const [showTagPanel, setShowTagPanel] = useState(false);
  /** v0.7.1 F8: graph view */
  const [showGraph, setShowGraph] = useState(false);
  /** hasAccount / onOpenTrash 的稳定布尔（供 commands 依赖） */
  const hasAccountFlag = !!state.account;
  const onOpenTrashFlag = !!vault;

  /** open palette; lazily load all note contents for the in-memory index */
  /** preload all note contents into the in-memory index */
  const openPalettePreload = useCallback(async () => {
    if (!vault || searchDocs.length > 0 || files.length === 0) return;
    try {
      const docs: SearchDoc[] = [];
      for (const path of files) {
        try {
          docs.push({ path, content: await io.read(vault.localPath ?? '', path) });
        } catch {
          // skip unreadable file
        }
      }
      setSearchDocs(docs);
    } catch {
      // degrade silently
    }
  }, [vault, io, files, searchDocs.length]);

  const openPalette = useCallback(
    async (mode: PaletteMode) => {
      if (!vault) return;
      await openPalettePreload();
      setPaletteMode(mode);
    },
    [vault, openPalettePreload]
  );

  /** v0.7.0 F4: open tags panel (preloads docs) */
  const openTagPanel = useCallback(async () => {
    await openPalettePreload();
    setShowTagPanel(true);
  }, [openPalettePreload]);

  /** global shortcuts: Ctrl+K search / Ctrl+O switcher / Ctrl+P commands */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'k') {
        e.preventDefault();
        void openPalette('search');
      } else if (k === 'o') {
        e.preventDefault();
        void openPalette('switcher');
      } else if (k === 'p') {
        e.preventDefault();
        void openPalette('commands');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openPalette]);
  const showPairCode = useCallback(async () => {
    if (!client) return;
    setPairBusy(true);
    try {
      const r = await client.createPairCode();
      setPairInfo({ code: r.code, expiresIn: r.expires_in });
    } catch (e) {
      toast(`生成配对码失败：${errText(e)}`, 'error');
    } finally {
      setPairBusy(false);
    }
  }, [client, toast]);
  const conflictFiles = lastReport?.conflicts ?? [];
  /** 从副本名反解原路径：xxx.conflict-<ts>.md -> xxx.md */
  const originalOf = (copy: string) => copy.replace(/\.conflict-\d{4}-\d{2}-\d{2}T[\d-]+\.md$/, '');

  /** 裁决：保留我的（原文件内容胜出），删掉副本 */
  const resolveKeepMine = useCallback(
    async (copy: string) => {
      if (!vault) return;
      try {
        await io.remove(vault.localPath ?? '', copy);
        setLastReport((r) => (r ? { ...r, conflicts: r.conflicts.filter((c) => c !== copy) } : r));
        await refreshFiles();
        void doSync();
        toast('已保留我的版本', 'ok');
      } catch (e) {
        toast(`操作失败：${errText(e)}`, 'error');
      }
    },
    [vault, io, refreshFiles, doSync, toast]
  );

  /** 裁决：采用副本（冲突副本内容胜出），写回原路径并删副本 */
  const resolveUseCopy = useCallback(
    async (copy: string) => {
      if (!vault) return;
      const original = originalOf(copy);
      try {
        const content = await io.read(vault.localPath ?? '', copy);
        await io.write(vault.localPath ?? '', original, content);
        await io.remove(vault.localPath ?? '', copy);
        if (currentPath === original) setDoc(content);
        setLastReport((r) => (r ? { ...r, conflicts: r.conflicts.filter((c) => c !== copy) } : r));
        await refreshFiles();
        void doSync();
        toast(`已采用冲突副本：${original}`, 'ok');
      } catch (e) {
        toast(`操作失败：${errText(e)}`, 'error');
      }
    },
    [vault, io, currentPath, refreshFiles, doSync, toast]
  );

  const purgeFromTrash = useCallback(
    async (trashPath: string) => {
      if (!vault) return;
      const ok = await confirm({
        title: '彻底删除',
        description: `${trashPath} 将被永久删除，不可恢复。`,
        okText: '永久删除',
        danger: true,
      });
      if (!ok) return;
      try {
        await io.remove(vault.localPath ?? '', trashPath);
        setTrashList((l) => l.filter((p) => p !== trashPath));
        await refreshFiles();
        void doSync();
      } catch (e) {
        toast(`删除失败：${errText(e)}`, 'error');
      }
    },
    [vault, io, refreshFiles, doSync, confirm, toast]
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

  /** v0.4.0 T4：导入进度（null=未在导入；否则显示 n/N） */
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null);

  const onImportObsidian = useCallback(async () => {
    if (!vault || importing) return;
    setImporting(true);
    setImportProgress({ done: 0, total: 0 });
    let failed: string[] = [];
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
        failed = [];
        setImportProgress({ done: 0, total: out.length });
        for (let i = 0; i < out.length; i++) {
          try {
            await io.write(vault.localPath ?? '', out[i].rel, await readTextFile(out[i].abs));
          } catch {
            failed.push(out[i].rel); // 单文件失败不中断整体导入
          }
          setImportProgress({ done: i + 1, total: out.length });
        }
        toast(
          failed.length === 0
            ? `已从 Obsidian 导入 ${out.length} 个笔记${stateRef.current.account ? '，正在同步到服务器…' : ''}`
            : `导入完成：成功 ${out.length - failed.length} 个，失败 ${failed.length} 个（首个失败：${failed[0]}）`,
          failed.length === 0 ? 'ok' : 'error'
        );
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
        failed = [];
        setImportProgress({ done: 0, total: entries.length });
        for (const e of entries) {
          try {
            await io.write(vault.localPath ?? '', e.rel, await e.getText());
            n++;
          } catch {
            failed.push(e.rel);
          }
          setImportProgress({ done: n + failed.length, total: entries.length });
        }
        toast(
          failed.length === 0
            ? `已从 Obsidian 导入 ${n} 个笔记${stateRef.current.account ? '，正在同步到服务器…' : ''}`
            : `导入完成：成功 ${n} 个，失败 ${failed.length} 个（首个失败：${failed[0]}）`,
          failed.length === 0 ? 'ok' : 'error'
        );
      }
      await refreshFiles();
      // v0.4.0 T4：导入完成自动同步一次（已登录时）
      if (client) void doUpload();
    } catch (e) {
      toast(`导入失败：${errText(e)}`, 'error');
    } finally {
      setImporting(false);
      setImportProgress(null);
    }
  }, [vault, importing, io, refreshFiles, toast, client, doUpload]);

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

  /** v0.7.1 F7: save pasted/dropped image into Attachments/ and return rel path */
  const onPasteImage = useCallback(
    async (file: File): Promise<string | null> => {
      if (!vault) return null;
      const data = new Uint8Array(await file.arrayBuffer());
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      let rel = `Attachments/${stamp}-${file.name.replace(/[\\/]/g, '_')}`;
      let i = 1;
      while (await io.exists(vault.localPath ?? '', rel).catch(() => false)) {
        rel = rel.replace(/(\.[a-z0-9]+)$/i, `-${i}$1`);
        i++;
      }
      await io.writeBinary(vault.localPath ?? '', rel, data);
      await refreshFiles();
      void doSync();
      return rel;
    },
    [vault, io, refreshFiles, doSync]
  );

  /** v0.7.0 F3: open or create a wiki link target */
  const onOpenWiki = useCallback(
    async (target: string) => {
      if (!vault) return;
      const existing = files.find((f) => titleOfPath(f) === target);
      if (existing) {
        void openFileInTab(existing);
        return;
      }
      await io.write(vault.localPath ?? '', `${target}.md`, `# ${target}\n\n`);
      await refreshFiles();
      void openFileInTab(`${target}.md`);
      void doSync();
      toast(`已创建：${target}`, 'ok');
    },
    [vault, files, io, refreshFiles, openFileInTab, doSync, toast]
  );

  /** v0.7.0 F3: outbound links of current note + inbound links (from cached docs) */
  const wikiLinks = useMemo(() => {
    if (!currentPath || !doc) return { out: [] as string[], back: [] as string[] };
    const out = extractLinks(doc);
    const inbound = new Set<string>();
    for (const d of searchDocs) {
      if (d.path === currentPath) continue;
      if (extractLinks(d.content).some((t) => t === titleOfPath(currentPath))) {
        inbound.add(d.path);
      }
    }
    return { out, back: [...inbound] };
  }, [currentPath, doc, searchDocs]);

  /** v0.7.1 F5: open-or-create today's daily note */
  const openDailyNote = useCallback(async () => {
    if (!vault) return;
    const path = todayPath();
    try {
      if (await io.exists(vault.localPath ?? '', path)) {
        void openFileInTab(path);
        return;
      }
      // 有模板则套用 Templates/日记.md，否则用默认骨架
      let content = dailyContent();
      if (templateFiles(files).some((f) => titleOfPath(f) === '日记')) {
        try {
          content = renderTemplateSafe(await io.read(vault.localPath ?? '', 'Templates/日记.md'), path);
        } catch { /* 模板读取失败用默认 */ }
      }
      await io.write(vault.localPath ?? '', path, content);
      await refreshFiles();
      void openFileInTab(path);
      void doSync();
    } catch (e) {
      toast(`打开日记失败：${errText(e)}`, 'error');
    }
  }, [vault, io, files, refreshFiles, openFileInTab, doSync, toast]);

  /** v0.7.1 F5: new note from a template (prompt to pick) */
  const newFromTemplate = useCallback(async () => {
    if (!vault) return;
    const tpls = templateFiles(files);
    if (tpls.length === 0) {
      // 首次使用：建模板目录 + 示例模板
      await io.write(
        vault.localPath ?? '',
        'Templates/会议.md',
        '# {{title}}\n\n- 时间：{{date}} {{time}}\n- 参会：\n\n## 议题\n\n## 结论\n'
      );
      await refreshFiles();
      toast('已创建 Templates/会议.md 示例模板，编辑后即可使用', 'ok');
      void doSync();
      return;
    }
    const name = await prompt({
      title: '从模板新建',
      description: `可用模板：${tpls.map((t) => titleOfPath(t)).join('、')}。输入新笔记名（可含目录）`,
      placeholder: '例：会议/产品周会',
      okText: '创建',
      validate: (v) => (v.trim() ? null : '请输入名称'),
    });
    if (!name) return;
    const clean = name.trim().replace(/\/+$/, '');
    const rel = clean.endsWith('.md') ? clean : `${clean}.md`;
    try {
      const tplPath = tpls.find((t) => titleOfPath(t) === titleOfPath(rel)) ?? tpls[0];
      const content = renderTemplateSafe(await io.read(vault.localPath ?? '', tplPath), rel);
      await io.write(vault.localPath ?? '', rel, content);
      await refreshFiles();
      void openFileInTab(rel);
      void doSync();
    } catch (e) {
      toast(`创建失败：${errText(e)}`, 'error');
    }
  }, [vault, files, io, refreshFiles, openFileInTab, doSync, prompt, toast]);

  /** renderTemplate 包装（title 去后缀） */
  function renderTemplateSafe(tpl: string, title: string): string {
    const base = title.replace(/\.md$/i, '').split('/').pop() ?? title;
    return renderTemplate(tpl, base);
  }

  /** v0.7.0 F2: command registry (Ctrl+P) */
  const commands: CommandItem[] = useMemo(
    () =>
      [
        { id: 'new-note', label: '新建笔记', run: () => void onCreateNote('') },
        { id: 'new-folder', label: '新建文件夹', run: () => void onCreateFolder('') },
        { id: 'import-obsidian', label: '从 Obsidian 导入', run: () => void onImportObsidian() },
        { id: 'daily', label: '打开今日笔记', run: () => void openDailyNote() },
        { id: 'graph', label: '打开图谱视图', run: () => { void openPalettePreload().then(() => setShowGraph(true)); } },
        { id: 'from-template', label: '从模板新建笔记', run: () => void newFromTemplate() },
        {
          id: 'toggle-theme',
          label: theme === 'light' ? '切换到深色主题' : '切换到浅色主题',
          run: () => setTheme(theme === 'light' ? 'dark' : 'light'),
        },
        hasAccountFlag ? { id: 'add-device', label: '添加设备（配对码）', run: () => void showPairCode() } : null,
        onOpenTrashFlag ? { id: 'trash', label: '打开回收站', run: () => void openTrash() } : null,
        // v0.7.2：应用内更新入口（手动检查）
        { id: 'check-update', label: `检查更新（当前 v${appVersion}）`, run: () => void runUpdateCheck(false) },
      ].filter((c): c is CommandItem => c !== null),
    [onCreateNote, onCreateFolder, onImportObsidian, openDailyNote, newFromTemplate, theme, hasAccountFlag, onOpenTrashFlag, showPairCode, openTrash, appVersion, runUpdateCheck]
  );

  // ---------- 渲染 ----------

  if (!state.account && showWelcome) {
    return (
      <div className="app">
        <WelcomeView
          onOpenFolder={() => {
            setShowWelcome(false);
            void onBindFolder();
          }}
          onImportObsidian={() => {
            setShowWelcome(false);
            void onImportObsidian();
          }}
          onCreateBlank={() => {
            setShowWelcome(false);
            void onCreateNote('');
          }}
          onOpenLogin={() => setShowLogin(true)}
        />
        {dialogEl}
        {toastEl}
      </div>
    );
  }

  // 登录页只在用户主动唤起且尚未登录时显示；平时无账号也直达主界面（本地模式）
  // 注意：此处 early return 之前所有 hooks 均已调用完毕（v0.3.3 修复 Rules of Hooks 违例）
  if (!state.account && showLogin) {
    return showGuide ? (
      <SetupGuide onBack={() => setShowGuide(false)} />
    ) : (
      <LoginView
        onLogin={onLogin}
        onPairLogin={onPairLogin}
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
          onRenameFile={(p, name) => void onRenameFile(p, name)}
          backlinks={wikiLinks.back}
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
          collapsedDirs={collapsedDirs}
          onToggleDir={toggleDir}
          onCreateFolder={(parent) => void onCreateFolder(parent ?? '')}
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
        onSelect={(p) => void openFileInTab(p)}
        onEdit={onEdit}
        onCreateNote={() => void onCreateNote('')}
        onNewFolderNote={(folder) => void onCreateNote(folder)}
        onDeleteFile={(p) => void onDeleteFile(p)}
        onSyncNow={() => void doSync()}
        onUpload={() => void doUpload()}
        onDownload={() => void doDownload()}
        onImportObsidian={() => void onImportObsidian()}
        tabs={openTabs}
        activeTab={activeTab}
        onSelectTab={(p) => void openFileInTab(p)}
        onCloseTab={closeTab}
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
        importProgress={importProgress}
        trashCount={trashList.length}
        onOpenTrash={() => void openTrash()}
        collapsedDirs={collapsedDirs}
        onToggleDir={toggleDir}
        onCreateFolder={(parent) => void onCreateFolder(parent ?? '')}
        conflictCount={conflictFiles.length}
        onOpenTags={() => void openTagPanel()}
        onPasteImage={onPasteImage}
        onOpenGraph={() => {
          void openPalettePreload().then(() => setShowGraph(true));
        }}
        onOpenWiki={(t) => void onOpenWiki(t)}
        wikiOut={wikiLinks.out}
        wikiBack={wikiLinks.back}
        onOpenWikiPath={(p) => void openFileInTab(p)}
        onOpenConflicts={() => setShowConflict(true)}
        onAddDevice={() => void showPairCode()}
        addDeviceBusy={pairBusy}
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
      {paletteMode && (
        <Palette
          mode={paletteMode}
          docs={searchDocs}
          commands={commands}
          onOpenNote={(p) => void openFileInTab(p)}
          onClose={() => setPaletteMode(null)}
        />
      )}
      {showGraph && (
        <GraphView
          docs={searchDocs}
          currentPath={currentPath}
          onOpenNote={(p) => {
            setShowGraph(false);
            void onOpenWiki(p.replace(/\.md$/i, ''));
          }}
          onClose={() => setShowGraph(false)}
        />
      )}
      {showTagPanel && (
        <div className="dlg-mask" onMouseDown={(e) => e.target === e.currentTarget && setShowTagPanel(false)}>
          <div className="dlg-card trash-card" role="dialog" aria-modal="true" aria-label="tags">
            <h2 className="dlg-title">{'\u6807\u7b7e'}</h2>
            {(() => {
              const idx = buildTagIndex(searchDocs);
              if (idx.size === 0)
                return <p className="dlg-desc">{'\u8fd8\u6ca1\u6709\u6807\u7b7e\u3002\u5728\u7b14\u8bb0\u91cc\u5199 #\u6807\u7b7e \u5373\u53ef\u3002'}</p>;
              return (
                <div className="tag-cloud">
                  {[...idx.entries()]
                    .sort((a, b) => b[1].length - a[1].length)
                    .map(([tag, paths]) => (
                      <button
                        key={tag}
                        className="tag-chip"
                        onClick={() => {
                          setShowTagPanel(false);
                          void openPalette('search');
                          window.setTimeout(() => {
                            const input = document.querySelector<HTMLInputElement>('.palette-input');
                            if (input) {
                              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                              setter?.call(input, '#' + tag);
                              input.dispatchEvent(new Event('input', { bubbles: true }));
                            }
                          }, 80);
                        }}
                      >
                        #{tag} <span className="tag-count">{paths.length}</span>
                      </button>
                    ))}
                </div>
              );
            })()}
            <div className="dlg-actions">
              <button className="btn primary" onClick={() => setShowTagPanel(false)}>
                {'\u5173\u95ed'}
              </button>
            </div>
          </div>
        </div>
      )}
      {pairInfo && (
        <div className="dlg-mask" onMouseDown={(e) => e.target === e.currentTarget && setPairInfo(null)}>
          <div className="dlg-card trash-card" role="dialog" aria-modal="true" aria-label="添加设备">
            <h2 className="dlg-title">添加设备</h2>
            <p className="dlg-desc">
              在新设备（手机/另一台电脑）的登录页点「已有配对码？免密码快速登录」，
              填入服务器地址和下面的配对码即可登录。
            </p>
            <div className="pair-code">{pairInfo.code}</div>
            <p className="dlg-desc">⏱ {pairInfo.expiresIn} 秒内有效，仅可使用一次</p>
            <div className="dlg-actions">
              <button
                className="btn ghost"
                onClick={() => {
                  void navigator.clipboard?.writeText(pairInfo.code);
                  toast('配对码已复制', 'ok');
                }}
              >
                复制配对码
              </button>
              <button className="btn primary" onClick={() => setPairInfo(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
      {showConflict && conflictFiles.length > 0 && (
        <div className="dlg-mask" onMouseDown={(e) => e.target === e.currentTarget && setShowConflict(false)}>
          <div className="dlg-card trash-card" role="dialog" aria-modal="true" aria-label="同步冲突">
            <h2 className="dlg-title">同步冲突（{conflictFiles.length}）</h2>
            <p className="dlg-desc">
              两台设备同时改了同一篇笔记。选择保留哪个版本；两个版本内容不同，建议先打开确认再选。
            </p>
            <ul className="trash-list">
              {conflictFiles.map((copy) => (
                <li key={copy} className="trash-item conflict-item">
                  <span className="ti-name" title={copy}>
                    {originalOf(copy)}
                  </span>
                  <button className="btn ghost" onClick={() => void openFile(copy)} title="先看看副本内容">
                    查看副本
                  </button>
                  <button className="btn ghost" onClick={() => void resolveKeepMine(copy)}>
                    保留我的
                  </button>
                  <button className="btn primary" onClick={() => void resolveUseCopy(copy)}>
                    用副本内容
                  </button>
                </li>
              ))}
            </ul>
            <div className="dlg-actions">
              <button className="btn primary" onClick={() => setShowConflict(false)}>
                稍后处理
              </button>
            </div>
          </div>
        </div>
      )}
      {showTrash && (
        <div className="dlg-mask" onMouseDown={(e) => e.target === e.currentTarget && setShowTrash(false)}>
          <div className="dlg-card trash-card" role="dialog" aria-modal="true" aria-label="回收站">
            <h2 className="dlg-title">回收站</h2>
            {trashList.length === 0 ? (
              <p className="dlg-desc">回收站是空的。</p>
            ) : (
              <ul className="trash-list">
                {trashList.map((p) => (
                  <li key={p} className="trash-item">
                    <span className="ti-name" title={p}>
                      {p.replace(/^\.trash\//, '')}
                    </span>
                    <button className="btn ghost" onClick={() => void restoreFromTrash(p)}>
                      恢复
                    </button>
                    <button className="btn danger" onClick={() => void purgeFromTrash(p)}>
                      彻底删除
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="dlg-actions">
              <button className="btn primary" onClick={() => setShowTrash(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
      {dialogEl}
      {toastEl}
    </div>
  );
}

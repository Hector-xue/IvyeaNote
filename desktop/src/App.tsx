import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LoginView } from './ui/LoginView';
import { SetupGuide } from './ui/SetupGuide';
import { MainView } from './ui/MainView';
import { MobileView } from './ui/MobileView';
import { useDialog } from './ui/Dialog';
import { useUpdater } from './hooks/useUpdater';
import { useTabs } from './hooks/useTabs';
import { useCommands } from './hooks/useCommands';
import { useAttachments } from './hooks/useAttachments';
import { useObsidianImport } from './hooks/useObsidianImport';
import { useTemplates } from './hooks/useTemplates';
import { useVaultFiles } from './hooks/useVaultFiles';
import { useSyncEngine } from './hooks/useSyncEngine';
import { useTrash, trashPathFor } from './hooks/useTrash';
import { useToast } from './ui/Toast';
import { WelcomeView, isWelcomed } from './ui/WelcomeView';
import { ApiError, SyncClient } from './lib/api';
import type { FileIO } from './lib/sync';
import { tauriIO, opfsIO, migrateFiles } from './lib/fs-adapters';
import { extractH1, titleToPath, uniqueName, sanitizeTitle } from './lib/titleSync';
import { loadCollapsed, saveCollapsed } from './ui/FileTree';
import { Palette } from './ui/Palette';
import { TagPanel } from './ui/TagPanel';
import { MoveDialog } from './ui/MoveDialog';
import { GraphView } from './ui/GraphView';
import { useNoteIndex } from './lib/noteIndex';
import {
  applyAppearance,
  loadAppearance,
  resolveTheme,
  saveAppearance,
  type Appearance,
} from './lib/appearance';
import { loadPrefs, savePrefs, type Prefs } from './lib/prefs';
import { SettingsView } from './ui/SettingsView';
import { SyncStatusPanel } from './ui/SyncStatusPanel';
import { AgentSection } from './ui/AgentSection';
import { loadRecent, pushRecent, saveRecent, remapRecent } from './lib/recent';
import { invertMoveOps, planMove, remapPath } from './lib/movePath';
import { noteCandidates } from './lib/links';
import { isSafPath, pickVaultFolder, safIO } from './lib/saf';
import {
  classifyVault,
  originalOfConflict,
  summarize,
  type FileSyncStatus,
} from './lib/syncStatus';
import { extractLinks, titleOfPath } from './lib/wikilink';
import {
  loadState,
  saveState,
  clearAccount,
  ensureLocalVault,
  mergeLocalIntoCloud,
  LOCAL_VAULT_ID,
  LOCAL_VAULT_NAME,
  newVaultMeta,
  nextLocalVaultId,
  type PersistState,
  type VaultMeta,
} from './lib/store';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** 移动端判定：真机 UA（Android/iOS）直接命中，或窄屏窗口——命中即用 MobileView 单栏布局 */
function useIsMobile(): boolean {
  const [m, setM] = useState(
    () =>
      isMobileUA() || window.matchMedia('(max-width: 768px)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const fn = () => setM(isMobileUA() || mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  return m;
}

/** 安卓专属分支：目录选择器要 Android SAF，Tauri 还没提供，文案得说实话 */
function isAndroidUA(): boolean {
  return typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
}

/** v0.7.4：Android WebView 报告的 CSS 宽度可能 >768 导致桌面布局误判（v0.7.3 真机反馈），UA 判定优先 */
function isMobileUA(): boolean {
  return typeof navigator !== 'undefined' && /android|iphone|ipad/i.test(navigator.userAgent);
}

function errText(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

/** 排序偏好持久化 */
export default function App() {
  // 免登录本地模式：无账号时初始化即带一个「我的笔记」本地库
  const [state, setState] = useState<PersistState>(() => {
    const s = loadState();
    return s.account ? s : ensureLocalVault(s);
  });
  const [vaultId, setVaultId] = useState<number | null>(null);
  /** v0.3.4：PDF 列表与元数据（排序） */
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  /** 同步拉取后要重读当前文件，但 currentPath 不能进 useSyncEngine 的依赖——
   *  否则每切换一次笔记就重建一次同步引擎。用 ref 旁路。 */
  const currentPathRef = useRef<string | null>(null);
  currentPathRef.current = currentPath;
  const [doc, setDoc] = useState<string | null>(null);
  /**
   * v0.8.2 E9：编辑区左右分栏。第二个窗格自带路径与内容——
   * `splitPath === currentPath` 就是「同文档双视图」，不同则是「两文档并排」。
   */
  const [splitPath, setSplitPath] = useState<string | null>(null);
  const [splitDoc, setSplitDoc] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  /** 按需唤起的登录页（免登录模式下从侧栏打开） */
  const [showLogin, setShowLogin] = useState(false);
  /** v0.4.0 T2：首启引导（仅未登录且首次启动显示） */
  const [showWelcome, setShowWelcome] = useState(() => !isWelcomed());
  /**
   * v0.7.10 E10：外观设置（主题 / 正文字号 / 宽度 / 行高 / 字体）。
   * 旧的 `ivnote.theme` 只存深浅；现在统一进 appearance，并支持「跟随系统」。
   * 迁移：loadAppearance 读不到新键时用默认值，老用户最多是主题回到浅色一次。
   */
  const [appearance, setAppearance] = useState<Appearance>(loadAppearance);
  /** v0.8.6 E10：行为偏好（默认值一律等于本次改动之前的行为） */
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const updatePrefs = useCallback((next: Prefs) => {
    setPrefs(next);
    savePrefs(next);
  }, []);
  const [showSettings, setShowSettings] = useState(false);
  const theme = resolveTheme(appearance.theme);

  const updateAppearance = useCallback((next: Appearance) => {
    setAppearance(next);
    saveAppearance(next);
    applyAppearance(next); // 改即生效，没有「保存」按钮
  }, []);

  const toggleTheme = useCallback(() => {
    setAppearance((cur) => {
      const next: Appearance = {
        ...cur,
        theme: resolveTheme(cur.theme) === 'light' ? 'dark' : 'light',
      };
      saveAppearance(next);
      applyAppearance(next);
      return next;
    });
  }, []);

  const stateRef = useRef(state);
  stateRef.current = state;

  // ---- v0.3.3：全部 hooks 必须在任何条件 return 之前调用（修复 Rules of Hooks 违例）----
  const isMobile = useIsMobile();
  /** 应用内对话框：替代 window.prompt/confirm（WebView2 不支持 prompt，静默返回 null） */
  const { prompt, confirm, dialogEl } = useDialog();
  /** 轻提示：替代 window.alert（安卓 WebView 里 alert 阻塞且割裂） */
  const { toast, toastEl } = useToast();
  /** 编辑防抖计时器：替代旧的「函数对象挂属性」写法（重构即坏、类型不安全） */
  /**
   * 落盘防抖定时器，**按路径分桶**。
   * 原来是单个 timer：分栏后左右两栏编辑不同文件时，后一次编辑会 clearTimeout 掉
   * 前一个文件还没落盘的那次写入——直接丢内容。
   */
  const saveTimers = useRef<Map<string, number>>(new Map());

  // ---- 应用内更新（v0.7.8：整块搬进 hooks/useUpdater） ----
  /** 当前版本：构建时由 vite define 注入（取自 tauri.conf.json），兜底 0.0.0 */
  const appVersion = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
  const { checkNow: checkUpdateNow } = useUpdater({
    confirm,
    toast,
    appVersion,
    isMobile: isMobileUA(),
  });


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

  /*
   * v0.10.2：未登录时也能有**多个**本地库。
   * 此前这里硬钉成 LOCAL_VAULT_ID，于是就算建出了第二个本地库也切不过去——
   * 「新建笔记库要先登录」的另一半原因就在这行。
   * 云端库（正数 id）仍然要登录才能用，未登录选中它就回落到默认本地库。
   */
  const activeVaultId = state.account ? vaultId : vaultId && vaultId < 0 ? vaultId : LOCAL_VAULT_ID;
  const vault: VaultMeta | null = activeVaultId ? state.vaults[String(activeVaultId)] ?? null : null;

  // 文件 IO：绑定了本地文件夹且在 Tauri 里 → 真实磁盘；否则 OPFS
  const io: FileIO = useMemo(() => {
    const vp = vault?.localPath;
    // v0.10.4：安卓 SAF 选出来的是 content:// 树 URI，既不是磁盘路径也不是 OPFS
    if (isSafPath(vp)) return safIO;
    // 'opfs://' 前缀是虚拟标记（本地库 / 移动端未绑定文件夹），统一走 OPFS
    if (vp && isTauri && !vp.startsWith('opfs://')) return tauriIO;
    return opfsIO(() => {
      // 必须用 activeVaultId：OPFS 的存储目录是 `vault-<id>`，
      // 拿 vaultId（未登录时可能是 null）会把第二个本地库读成默认库
      const m = stateRef.current.vaults[String(activeVaultId ?? '')];
      return m ?? newVaultMeta(LOCAL_VAULT_ID, 'tmp');
    });
  }, [vault?.localPath, activeVaultId]);

  /**
   * 文件列表层（v0.7.8：整块搬进 hooks/useVaultFiles）。
   * 这是数据咽喉——所有改动文件的操作最后都要走 refreshFiles()。
   */
  const {
    files,
    pdfs,
    mdStamps,
    emptyDirs,
    allPaths,
    sortMode,
    setSortMode,
    refresh: refreshFiles,
  } = useVaultFiles(io, vault ? (vault.localPath ?? '') : null);


  /**
   * v0.7.5 P0：全库正文索引。
   *
   * 旧实现是 `searchDocs` state + `openPalettePreload`：只在打开命令面板时建**一次**，
   * 且开头 `if (searchDocs.length > 0) return` 保证此后永不更新。后果——
   * 桌面端没按过 Ctrl+K 之前反链恒空；移动端没有任何触发入口，所以 v0.7.3 宣称的
   * 「反向链接区块」在真机上从未显示过；建完之后新写的笔记也进不了索引。
   *
   * 现在索引由 refreshFiles 的指纹快照驱动，增量对账，无需任何人记得去"预载"。
   */
  const noteIndex = useNoteIndex(io, vault?.localPath ?? '', mdStamps);
  const searchDocs = noteIndex.docs;


  /** 执行一轮完整同步（推送本地增量 + 拉取远端变更） */
  /** 同步引擎（v0.7.8：三个复制粘贴的函数收进 hooks/useSyncEngine） */
  const afterPull = useCallback(async () => {
    const cur = currentPathRef.current;
    if (!vault || !cur) return;
    try {
      setDoc(await io.read(vault.localPath ?? '', cur));
    } catch {
      // 远端把这篇删了：清空编辑区，别让用户对着一份已不存在的内容继续写
      setCurrentPath(null);
      setDoc(null);
    }
  }, [vault, io]);

  const {
    syncing,
    lastReport,
    setLastReport,
    sync: doSync,
    upload: doUpload,
    download: doDownload,
  } = useSyncEngine({
    client,
    vault: vault ?? null,
    io,
    deviceId: state.account?.deviceId,
    refresh: refreshFiles,
    persist: () => persist({ ...stateRef.current }),
    afterPull,
    errText,
  });

  // ---------- v0.3.4：插图 / 图片解析 / PDF（v0.8.0 P1.4 搬进 hooks/useAttachments） ----------

  const onShowPdf = useCallback(() => {
    // PDF 与笔记在主区互斥：先把编辑器清干净
    setCurrentPath(null);
    setDoc(null);
  }, []);
  const {
    pdfView,
    insertImage: onInsertImage,
    saveImageFile: onPasteImage,
    resolveImage,
    openPdf: onOpenPdf,
    closePdf: onClosePdf,
  } = useAttachments({
    vaultPath: vault ? vault.localPath ?? '' : null,
    io,
    refreshFiles,
    doSync: () => void doSync(),
    toast,
    onShowPdf,
    errText,
  });


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
            // 走 newVaultMeta 而不是手拼字面量：漏掉 localPath 会让同步静默失效
            merged[String(created.id)] = {
              ...newVaultMeta(created.id, LOCAL_VAULT_NAME),
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

  // 选了「跟随系统」时，系统深浅色一变就要跟着换
  useEffect(() => {
    if (appearance.theme !== 'system') return;
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const on = () => applyAppearance(appearance);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, [appearance]);

  // 免登录本地模式：确保本地库存在并落盘（老用户首次升级也生效）
  useEffect(() => {
    if (!stateRef.current.account) persist(ensureLocalVault());
  }, [persist]);

  // v0.6.1 H7a：全自动同步——启动后 2s / 窗口聚焦 / 每 60s 兜底轮询。
  // 编辑落盘后的推送已在 onEdit 防抖里触发，这里补齐其余时机；
  // doSync 内部有 syncingRef 重入保护，多时机并发安全。
  useEffect(() => {
    if (!client || !prefs.autoSync) return;
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
  }, [client, prefs.autoSync, doSync]);

  // 卸载时清理编辑防抖计时器
  useEffect(
    () => () => {
      for (const t of saveTimers.current.values()) window.clearTimeout(t);
    },
    []
  );

  /**
   * v0.7.5 1.3：文件系统监听。
   *
   * 「卸载软件后目录里还是标准 Markdown、可以用 Obsidian/VSCode 直接打开」是本产品
   * 的第一卖点，可 v0.7.4 之前**外部改了文件应用完全不知道**——侧栏不更新、索引不更新，
   * 下一次同步还可能拿旧状态去推。
   *
   * 用 plugin-fs 自带的 watch（无需新增 Rust 依赖，只要 `fs:allow-watch` 权限），
   * 800ms 去抖，事件只用来触发 refreshFiles——真正判断「哪几个文件变了」仍然由
   * 索引层按 mtime+size 对账，watcher 只是个「该看一眼了」的信号。
   */
  useEffect(() => {
    const root = vault?.localPath;
    if (!isTauri || !root) return;
    let stop: (() => void) | undefined;
    let disposed = false;
    void (async () => {
      try {
        const { watch } = await import('@tauri-apps/plugin-fs');
        const un = await watch(
          root,
          (e) => {
            // 忽略软件自己的元数据目录：索引快照每 10 秒落一次盘，
            // 不过滤的话会自己触发自己，白白重扫一遍文件列表。
            const paths = Array.isArray(e.paths) ? e.paths : [];
            if (paths.length > 0 && paths.every((p) => p.replace(/\\/g, '/').includes('/.ivyea/')))
              return;
            void refreshFiles();
          },
          { recursive: true, delayMs: 800 }
        );
        if (disposed) un();
        else stop = un;
      } catch (err) {
        // 监听不可用（权限缺失 / 平台不支持）不影响主流程：手动刷新和同步仍然工作
        console.warn('文件监听未启用', err);
      }
    })();
    return () => {
      disposed = true;
      stop?.();
    };
  }, [vault?.localPath, refreshFiles]);

  // ---------- 文件操作 ----------

  /** v0.7.10 E6：最近打开，供快速切换器排序 */
  const [recent, setRecent] = useState<string[]>(loadRecent);

  const openFile = useCallback(
    async (path: string) => {
      if (!vault) return;
      try {
        const text = await io.read(vault.localPath ?? '', path);
        onClosePdf();
        setCurrentPath(path);
        setDoc(text);
        setRecent((cur) => {
          const next = pushRecent(cur, path);
          saveRecent(next);
          return next;
        });
      } catch (e) {
        toast(`打开失败：${errText(e)}`, 'error');
      }
    },
    [vault, io, toast, onClosePdf]
  );

  /** E9：在右侧窗格打开一篇笔记（不传则复制当前这篇，即「同文档双视图」） */
  const openSplit = useCallback(
    async (path?: string) => {
      if (!vault) return;
      const target = path ?? currentPath;
      if (!target) return;
      try {
        const text = await io.read(vault.localPath ?? '', target);
        setSplitPath(target);
        setSplitDoc(text);
      } catch (e) {
        toast(`右侧打开失败：${errText(e)}`, 'error');
      }
    },
    [vault, io, currentPath, toast]
  );
  const closeSplit = useCallback(() => {
    setSplitPath(null);
    setSplitDoc(null);
  }, []);
  /** 右栏那篇被改名/移动了：跟着换路径，否则右栏会指向一个已不存在的文件 */
  const remapSplit = useCallback((ops: readonly { from: string; to: string }[]) => {
    if (ops.length === 0) return;
    const map = new Map(ops.map((o) => [o.from, o.to]));
    setSplitPath((cur) => (cur ? (map.get(cur) ?? cur) : cur));
  }, []);

  /** 改名/移动后同步 recent —— 与 remapTabs 成对出现，漏一个就留下死路径 */
  const remapRecentPaths = useCallback((ops: readonly { from: string; to: string }[]) => {
    setRecent((cur) => {
      const next = remapRecent(cur, ops);
      saveRecent(next);
      return next;
    });
  }, []);

  /** 多标签页（v0.7.8：整块搬进 hooks/useTabs） */
  const onTabsEmpty = useCallback(() => {
    setCurrentPath(null);
    setDoc(null);
  }, []);
  const { openTabs, activeTab, openInTab: openFileInTab, closeTab, remap: remapTabs } = useTabs({
    openFile,
    onEmpty: onTabsEmpty,
  });

  /**
   * v0.4.0 T3：标题跟随——编辑防抖落盘后，若正文首个 H1 与当前文件名不一致，
   * 自动把文件重命名为标题（同目录内、清洗非法字符）。
   * 同步层把改名表达为「新路径 upsert + 旧路径 delete」，多端自然收敛。
   */
  const maybeRenameToH1 = useCallback(
    async (path: string, text: string) => {
      if (!vault || !prefs.titleSync || !/\.md$/i.test(path)) return;
      const h1 = extractH1(text);
      if (!h1) return;
      const target = titleToPath(path, h1);
      if (target === path) return;
      try {
        if (await io.exists(vault.localPath ?? '', target)) return; // 目标已存在：不抢名
        await io.write(vault.localPath ?? '', target, text);
        await io.remove(vault.localPath ?? '', path);
        setCurrentPath(target);
        // 标签里存的还是旧路径，不改就会指向一个已经不存在的文件
        remapTabs([{ from: path, to: target }]);
        remapRecentPaths([{ from: path, to: target }]);
        remapSplit([{ from: path, to: target }]);
        setDoc(text);
        await refreshFiles();
        toast(`已按标题重命名：${path.split('/').pop()} → ${target.split('/').pop()}`, 'ok');
        void doSync();
      } catch {
        // 改名失败不影响编辑主流程
      }
    },
    [vault, prefs.titleSync, io, refreshFiles, doSync, toast, remapTabs, remapRecentPaths, remapSplit]
  );

  const onEdit = useCallback(
    (path: string, text: string) => {
      if (!vault) return;
      // 只接受当前正在编辑的两个窗格之一发来的改动；别的都是已经换掉的旧编辑器
      const isMain = path === currentPath;
      const isSplit = path === splitPath;
      if (!isMain && !isSplit) return;
      if (isMain) setDoc(text);
      if (isSplit) setSplitDoc(text);
      // 防抖写盘；真正的推送发生在下一轮 syncVault 扫描（content !== base）
      window.clearTimeout(saveTimers.current.get(path));
      saveTimers.current.set(path, window.setTimeout(async () => {
        try {
          await io.write(vault.localPath ?? '', path, text);
          // v0.7.5：即时更新索引。未登录的本地模式下 doSync() 会直接 return、
          // 不触发 refreshFiles，光靠咽喉对账的话离线写作时反链/搜索会滞后一拍。
          noteIndex.touch(path, text);
          // 「自动同步」关掉时，落盘后也不再顺手推——设置里写的是「关掉后只能手动同步」，
          // 只挡住启动/回前台/轮询那三条而放行这一条，说明就成了假话（v0.8.6 的疏漏）。
          if (prefs.autoSync) void doSync();
          // v0.4.0：标题跟随（在写盘之后执行，避免和防抖写盘竞争）
          void maybeRenameToH1(path, text);
        } catch (e) {
          console.error('写盘失败', e);
        } finally {
          saveTimers.current.delete(path);
        }
      }, 800));
    },
    [vault, io, currentPath, splitPath, prefs.autoSync, doSync, maybeRenameToH1, noteIndex]
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
      /*
       * v0.10.1：**不再往正文塞 `# untitled`**。标题现在由内联标题承担
       * （文件名即标题），正文再写一行 H1 就是同一个标题出现两遍，
       * 而且光标落上去还会露出 `#` 号。
       */
      await io.write(vault.localPath ?? '', rel, '');
      await refreshFiles();
      // 新建的笔记也要进标签页——此前走的是 openFile，于是「新建」出来的笔记
      // 永远不出现在标签栏里，标签栏在只用新建的场景下根本不显示
      void openFileInTab(rel);
      void doSync();
    },
    [vault, files, io, refreshFiles, openFileInTab, doSync]
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
        remapTabs([{ from: path, to: final }]);
        remapRecentPaths([{ from: path, to: final }]);
        remapSplit([{ from: path, to: final }]);
        await refreshFiles();
        void doSync();
        toast(`已重命名：${titleOfPath(path)} → ${titleOfPath(final)}`, 'ok');
      } catch (e) {
        toast(`重命名失败：${errText(e)}`, 'error');
      }
    },
    [vault, io, currentPath, refreshFiles, doSync, toast, remapTabs, remapRecentPaths, remapSplit]
  );

  /**
   * v0.7.5 E1：侧栏拖拽移动文件 / 文件夹。
   *
   * 路径计算全部放在 `lib/movePath` 的纯函数里——移动是破坏性操作，算错落点
   * 就是把用户的笔记搬丢，这类逻辑必须可单测。这里只负责按结果做 IO。
   *
   * 用二进制读写而不是文本：库里除了 .md 还有 Attachments/ 下的图片和 PDF，
   * 走文本通道会把它们损坏。
   *
   * 同步语义：表达为「新路径 upsert + 旧路径 delete」，与 v0.4.0 标题跟随改名一致，
   * 多端自然收敛。
   */
  /**
   * 真正搬文件的那一步。移动与「撤销移动」共用它——撤销就是把 ops 反过来再走一遍，
   * 两条路必须共用同一份实现，否则撤销迟早和移动对不上。
   *
   * 用二进制读写而不是文本：库里除了 .md 还有 Attachments/ 下的图片和 PDF。
   */
  const applyMoveOps = useCallback(
    async (ops: readonly { from: string; to: string }[]) => {
      if (!vault) return;
      const root = vault.localPath ?? '';
      for (const op of ops) {
        const data = await io.readBinary(root, op.from);
        await io.writeBinary(root, op.to, data);
        await io.remove(root, op.from);
      }
      // 正在打开的文件被移走了：编辑区、标签、最近打开、右栏都得跟着换路径
      setCurrentPath((cur) => remapPath(cur, ops));
      remapTabs(ops);
      remapRecentPaths(ops);
      remapSplit(ops);
      await refreshFiles();
      void doSync();
    },
    [vault, io, refreshFiles, doSync, remapTabs, remapRecentPaths, remapSplit]
  );

  /**
   * v0.8.7 E1：移动的撤销栈。
   * 方案点名要 Ctrl+Z——移动是破坏性操作，搬错地方却退不回来是很吓人的。
   * 只存路径对，不存内容，所以栈本身几乎不占东西。
   */
  const [moveUndo, setMoveUndo] = useState<{ from: string; to: string }[][]>([]);

  const onMovePath = useCallback(
    async (src: string, destDir: string, isDir: boolean) => {
      if (!vault) return;
      // 重名消解要看**全部**已知路径（.md / .pdf / .keep / 附件），只看 files 会漏判
      const ops = planMove(src, destDir, allPaths(), isDir);
      if (!ops) return;
      try {
        await applyMoveOps(ops);
        setMoveUndo((st) => [...st.slice(-9), ops]); // 最多留 10 步
        const label = destDir || '库根目录';
        toast(
          (ops.length === 1 ? `已移动到「${label}」` : `已移动 ${ops.length} 个文件到「${label}」`) +
            '，Ctrl+Z 可撤销',
          'ok'
        );
      } catch (e) {
        toast(`移动失败：${errText(e)}`, 'error');
        await refreshFiles();
      }
    },
    [vault, allPaths, applyMoveOps, refreshFiles, toast]
  );

  /** 撤销上一次移动：把 ops 首尾对调再走一遍 */
  const undoLastMove = useCallback(async () => {
    const last = moveUndo[moveUndo.length - 1];
    if (!last) return;
    setMoveUndo((st) => st.slice(0, -1));
    try {
      await applyMoveOps(invertMoveOps(last));
      toast(last.length === 1 ? '已撤销移动' : `已撤销移动（${last.length} 个文件）`, 'ok');
    } catch (e) {
      toast(`撤销失败：${errText(e)}`, 'error');
      await refreshFiles();
    }
  }, [moveUndo, applyMoveOps, refreshFiles, toast]);

  /**
   * Ctrl+Z 撤销移动。**只在焦点不在编辑器里时接管**——编辑器里的 Ctrl+Z 是
   * CodeMirror 的文本撤销，抢过来会让人写字时突然把文件搬回去，那是灾难。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== 'z') return;
      const el = document.activeElement;
      if (el && el.closest('.md-editor, input, textarea')) return;
      if (moveUndo.length === 0) return;
      e.preventDefault();
      void undoLastMove();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [moveUndo.length, undoLastMove]);

  /**
   * v0.7.9 E3：右键菜单里的「重命名」。
   * 弹框留在 App 层——对话框归 useDialog 管，UI 组件不该自己造输入框。
   */
  const requestRename = useCallback(
    async (path: string) => {
      const cur = path.split('/').pop()?.replace(/\.(md|markdown)$/i, '') ?? '';
      const name = await prompt({
        title: '重命名笔记',
        initial: cur,
        okText: '重命名',
        validate: (v) => (v.trim() ? null : '名字不能为空'),
      });
      if (name) await onRenameFile(path, name);
    },
    [prompt, onRenameFile]
  );

  /** v0.7.9 E3：复制库内相对路径（贴到别处引用时用） */
  const copyPath = useCallback(
    async (path: string) => {
      try {
        await navigator.clipboard.writeText(path);
        toast('已复制路径', 'ok');
      } catch {
        // WebView 里剪贴板可能被拒；退回让用户自己看一眼路径，别静默失败
        toast(`复制失败，路径是：${path}`, 'error');
      }
    },
    [toast]
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
        // 移入回收站而非物理删除；目录结构编码进文件名（sub/b.md → sub__b.md），
        // 恢复时由 useTrash 的 originalPathOf 反解。两处必须用同一套规则，
        // 所以路径生成收在 hooks/useTrash 里，不再在这儿手拼。
        let trashRel = trashPathFor(path);
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
        // 右栏开的正是这篇：关掉，否则会停在一个已经进回收站的文件上
        if (splitPath === path) closeSplit();
        await refreshFiles();
        void doSync();
      } catch (e) {
        toast(`删除失败：${errText(e)}`, 'error');
      }
    },
    [vault, io, currentPath, splitPath, closeSplit, refreshFiles, doSync, confirm, toast]
  );

  /**
   * v0.4.0 T5：回收站。
   * 列出 .trash/ 下全部条目；支持恢复（移回原目录）与彻底删除。
   */
  const trash = useTrash({
    io,
    vaultPath: vault?.localPath ?? (vault ? '' : null),
    refreshFiles,
    sync: () => void doSync(),
    toast,
    confirm,
    errText,
  });


  /** v0.6.1 H7c：冲突待处理队列（conflict 副本路径列表，从最近同步报告收集） */
  const [showConflict, setShowConflict] = useState(false);
  /** v0.6.1 H6: add-device pairing code dialog */
  const [pairInfo, setPairInfo] = useState<{ code: string; expiresIn: number } | null>(null);
  const [pairBusy, setPairBusy] = useState(false);
  /** v0.7.0 F4: tags panel */
  const [showTagPanel, setShowTagPanel] = useState(false);
  /** 移动端点标签后要搜的词（命令面板在手机上不渲染，得走抽屉里的全文搜索） */
  const [mobileSearchSeed, setMobileSearchSeed] = useState<{ text: string; n: number } | null>(null);
  /** v0.8.4 E7：待跳转的行（打开某篇 + 定位）。带序号，连点同一行也要重新跳 */
  const [jumpTo, setJumpTo] = useState<{ path: string; line: number; n: number } | null>(null);
  /** v0.9.2 P4.3：同步状态面板 */
  const [showSyncStatus, setShowSyncStatus] = useState(false);
  const [syncStatusList, setSyncStatusList] = useState<FileSyncStatus[]>([]);
  const [syncStatusBusy, setSyncStatusBusy] = useState(false);

  /** 「移动到…」选择器：桌面右键与移动端长按共用 */
  const [moving, setMoving] = useState<{ path: string; isDir: boolean } | null>(null);
  /** v0.7.1 F8: graph view */
  const [showGraph, setShowGraph] = useState(false);

  /** v0.7.0 F4: open tags panel */
  const openTagPanel = useCallback(() => {
    setShowTagPanel(true);
  }, []);
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
  /**
   * 从副本名反解原路径。原来这里自己写了一份正则且**把 .md 一起吃掉了**
   * （`replace(SUFFIX, '')`），「采用副本」于是写进一个没有扩展名的新文件、
   * 原笔记纹丝不动。现在与同步状态面板共用 lib/syncStatus 的那一份。
   */
  const originalOf = originalOfConflict;

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


  // ---------- Obsidian 一键导入（v0.8.0 P1.4 搬进 hooks/useObsidianImport） ----------

  const { progress: importProgress, run: onImportObsidian } = useObsidianImport({
    vaultPath: vault ? vault.localPath ?? '' : null,
    io,
    refreshFiles,
    // 已登录才在导入后推一次；未登录传 null，文案里也不会说「正在同步到服务器」
    afterImport: client ? () => void doUpload() : null,
    toast,
    errText,
  });

  // ---------- Vault / 文件夹绑定 ----------

  /**
   * 新建笔记库。
   *
   * v0.10.2：**未登录也能建**。此前第一句是「云同步需要登录」直接 return——
   * 可"建一个笔记本"跟服务器毫无关系，登录只该影响同步这一件事。
   * 未登录时建的是本地库（负数 id，OPFS 里各占一个目录）；登录后建的仍是云端库。
   */
  const createVault = useCallback(async () => {
    const name = await prompt({
      title: '新建笔记库',
      placeholder: '笔记库名称',
      okText: '创建',
      validate: (v) => (v.trim() ? null : '请输入名称'),
    });
    if (!name) return;
    const cur = stateRef.current;
    if (!client) {
      const id = nextLocalVaultId(cur.vaults);
      persist({ ...cur, vaults: { ...cur.vaults, [String(id)]: newVaultMeta(id, name.trim()) } });
      setVaultId(id);
      setCurrentPath(null);
      setDoc(null);
      toast(`已创建本地笔记库「${name.trim()}」`, 'ok');
      return;
    }
    try {
      const v = await client.createVault(name.trim());
      persist({ ...cur, vaults: { ...cur.vaults, [String(v.id)]: newVaultMeta(v.id, v.name) } });
      setVaultId(v.id);
      setCurrentPath(null);
      setDoc(null);
    } catch (e) {
      toast(`创建失败：${errText(e)}`, 'error');
    }
  }, [client, persist, prompt, toast]);

  /**
   * 选择笔记库在磁盘上的位置。
   *
   * v0.10.2 两处补课：
   * ① **搬家而不是换招牌**。此前只改 `localPath` 就完事，原来存在 OPFS 里的笔记
   *    一篇都不跟着走——用户点完"选择文件夹"眼前突然空了，以为笔记全没了
   *    （其实还在 OPFS 里，但界面上再也回不去）。现在先复制过去再改指向，
   *    复制失败就**不改指向**，保证任何一步出错笔记都还在原地看得见。
   * ② 失败要说话。选不了目录（安卓 WebView 没有目录选择器）时给明确提示，
   *    而不是点一下什么都不发生。
   */
  const onBindFolder = useCallback(async () => {
    if (!vault) return;
    if (!isTauri) {
      toast('浏览器版使用内置虚拟存储（OPFS），无法选择磁盘目录；请在桌面 App 中设置。', 'error');
      return;
    }
    /*
     * v0.10.4：安卓走 **SAF**（Storage Access Framework），桌面仍走系统文件夹对话框。
     *
     * 两者拿到的东西不是一类：桌面是磁盘绝对路径，安卓是 `content://` 树 URI。
     * 但对下游是一样的——都只是 `vault.localPath`，由 `io` 按前缀选适配器。
     * 上游 tauri-plugin-dialog 的安卓实现里只有选文件/另存为，**没有选目录**，
     * 所以安卓这条必须走我们自己的插件（src-tauri/plugins/ivnote-saf）。
     */
    let sel: string | null = null;
    let label: string | null = null;
    try {
      if (isAndroidUA()) {
        const picked = await pickVaultFolder();
        if (!picked) return; // 用户取消
        sel = picked.uri;
        label = picked.name;
      } else {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const r = await open({ directory: true });
        if (typeof r !== 'string' || !r) return; // 用户取消
        sel = r;
      }
    } catch (e) {
      toast(`选择文件夹失败：${errText(e)}`, 'error');
      return;
    }

    const from = vault.localPath ?? '';
    if (from === sel) return;
    const wasVirtual = !from || from.startsWith('opfs://');
    const count = allPaths.length;
    const shownDest = label ?? sel;
    if (count > 0) {
      const ok = await confirm({
        title: '移动笔记到新位置',
        description: `将把当前笔记库的 ${count} 个文件复制到：\n${shownDest}\n\n复制完成后，笔记库指向新位置。原位置的文件不会被删除，可自行清理。`,
        okText: '开始移动',
      });
      if (!ok) return;
      try {
        const srcIo = wasVirtual ? opfsIO(() => vault) : isSafPath(from) ? safIO : tauriIO;
        const dstIo = isSafPath(sel) ? safIO : tauriIO;
        await migrateFiles(srcIo, wasVirtual ? '' : from, dstIo, sel);
      } catch (e) {
        // 关键：复制没成功就**不动 localPath**，笔记留在原地仍然打得开
        toast(`移动失败，笔记库位置未改变：${errText(e)}`, 'error');
        return;
      }
    }
    patchVault(vault.id, (m) => {
      m.localPath = sel as string;
      m.localLabel = label ?? undefined;
    });
    await refreshFiles();
    toast(count > 0 ? `已移动 ${count} 个文件到新位置` : '已设置笔记库位置', 'ok');
  }, [vault, allPaths.length, patchVault, confirm, toast, refreshFiles]);

  /**
   * 撤回到应用内部存储。
   *
   * v0.10.2：加一次确认并说清后果——内部存储**卸载即清空**，
   * 这是「安卓更新完笔记没了」这类事故的源头，不该一声不响地切过去。
   * 磁盘上的原文件保留不动，所以这个动作本身不会删任何东西。
   */
  const onUnbindFolder = useCallback(async () => {
    if (!vault) return;
    const ok = await confirm({
      title: '改回应用内部存储',
      description: '笔记库将改用应用内部存储。内部存储的笔记在卸载应用时会被一并删除，且无法用其它编辑器打开。\n\n磁盘上原文件夹里的文件会保留，不会被删除。',
      okText: '仍然改回',
    });
    if (!ok) return;
    patchVault(vault.id, (m) => {
      m.localPath = `opfs://${vault.id}`;
      m.localLabel = undefined;
    });
    await refreshFiles();
  }, [vault, patchVault, confirm, refreshFiles]);

  const onLogout = useCallback(() => {
    // 只清登录态，保留全部本地笔记（含免登录本地库），下次登录可继续迁移
    clearAccount();
    setState((s) => ({ ...s, account: undefined }));
    setShowLogin(false);
    setCurrentPath(null);
    setDoc(null);
    setLastReport(null);
  }, []);

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

  /**
   * v0.10.2：普通 Markdown 链接指向库内文件时怎么办。
   * 编辑器已经把相对路径解析成库内路径，这里只负责「用什么打开」：
   * - 笔记：开标签页（后缀可省，`.md`/`.markdown` 都试一遍）
   * - PDF：走既有的 PDF 视图（安卓交系统应用）
   * - 其它附件：交系统默认程序；OPFS 库没有磁盘路径，只能提示
   *
   * 找不到目标时**不静默**——链接点了没反应是最难排查的一种坏。
   */
  const onOpenLinkPath = useCallback(
    (rel: string) => {
      if (!vault || !rel) return;
      const hit = noteCandidates(rel).find((c) => files.includes(c));
      if (hit) {
        void openFileInTab(hit);
        return;
      }
      if (/\.pdf$/i.test(rel)) {
        if (pdfs.includes(rel)) {
          void onOpenPdf(rel);
          return;
        }
        toast(`库里没有这个文件：${rel}`, 'error');
        return;
      }
      const root = vault.localPath ?? '';
      if (!root || root.startsWith('opfs://')) {
        toast(`库里没有这个笔记：${rel}`, 'error');
        return;
      }
      // 附件走 openPath 而不是 openUrl：file:// URL 在 Windows 上会被 opener 拒掉
      void (async () => {
        try {
          const { openPath } = await import('@tauri-apps/plugin-opener');
          await openPath(`${root.replace(/\/$/, '')}/${rel}`);
        } catch (e) {
          toast(`无法打开：${errText(e)}`, 'error');
        }
      })();
    },
    [vault, files, pdfs, openFileInTab, onOpenPdf, toast]
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

    /** v0.8.0 P1.4：日记 / 模板搬进 hooks/useTemplates */
  const { openDaily: openDailyNote, newFromTemplate } = useTemplates({
    vaultPath: vault ? vault.localPath ?? '' : null,
    io,
    files,
    refreshFiles,
    openInTab: (p) => void openFileInTab(p),
    doSync: () => void doSync(),
    prompt,
    toast,
    errText,
  });

  /**
   * v0.8.0 P1.4：命令面板 + 全局快捷键整块搬进 `hooks/useCommands`。
   * 这里只负责把「能干什么」交出去——hook 不认识 vault，也不碰 IO。
   */
  /**
   * 现算每文件的同步状态。要读全部正文，所以**只在打开面板/点重新统计时算**，
   * 不挂在渲染里——不然每敲一个字都要把整个库读一遍。
   */
  const refreshSyncStatus = useCallback(async () => {
    if (!vault) return;
    setSyncStatusBusy(true);
    try {
      const root = vault.localPath ?? '';
      const contents = new Map<string, string>();
      for (const p of files) {
        try {
          contents.set(p, await io.read(root, p));
        } catch {
          // 读不出来的单篇跳过，不让整次统计失败
        }
      }
      setSyncStatusList(classifyVault(contents, vault));
    } finally {
      setSyncStatusBusy(false);
    }
  }, [vault, io, files]);

  const openSyncStatus = useCallback(() => {
    setShowSyncStatus(true);
    void refreshSyncStatus();
  }, [refreshSyncStatus]);

  const commandActions = useMemo(
    () => ({
      onCreateNote: () => void onCreateNote(''),
      onCreateFolder: () => void onCreateFolder(''),
      onImportObsidian: () => void onImportObsidian(),
      onOpenDaily: () => void openDailyNote(),
      onOpenGraph: () => setShowGraph(true),
      onToggleSplit: () => (splitPath ? closeSplit() : void openSplit()),
      onOpenSyncStatus: openSyncStatus,
      onNewFromTemplate: () => void newFromTemplate(),
      onToggleTheme: toggleTheme,
      onOpenSettings: () => setShowSettings(true),
      onCheckUpdate: checkUpdateNow,
      onAddDevice: state.account ? () => void showPairCode() : null,
      onOpenTrash: vault ? () => void trash.reload() : null,
    }),
    [
      onCreateNote,
      onCreateFolder,
      onImportObsidian,
      openDailyNote,
      newFromTemplate,
      toggleTheme,
      splitPath,
      closeSplit,
      openSplit,
      openSyncStatus,
      checkUpdateNow,
      showPairCode,
      trash,
      state.account,
      vault,
    ]
  );
  const { paletteMode, openPalette, closePalette, commands } = useCommands({
    enabled: !!vault,
    splitOpen: !!splitPath,
    theme,
    appVersion,
    actions: commandActions,
  });

  /**
   * 点标签 → 搜这个标签。桌面走命令面板的搜索模式；面板的输入框是非受控的，
   * 只能用原生 setter + input 事件把值灌进去（React 不认直接赋 value）。
   */
  const searchTag = useCallback(
    (tag: string) => {
      openPalette('search');
      window.setTimeout(() => {
        const input = document.querySelector<HTMLInputElement>('.palette-input');
        if (!input) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, '#' + tag);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, 80);
    },
    [openPalette]
  );


  /** 库内全部目录（笔记路径推导出来的 + 只有 .keep 的空目录），供「移动到…」列表用 */
  const allDirs = useMemo(() => {
    const set = new Set<string>(emptyDirs);
    for (const f of files) {
      const parts = f.split('/');
      for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'));
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  }, [files, emptyDirs]);

  /*
   * v0.10.2：设置面板抽成变量，**移动端也要能打开**。
   * 此前它只挂在桌面分支里，于是手机上没有任何地方能看到（更别说改）
   * 「笔记存在哪」——而安卓恰恰是"卸载即丢笔记"后果最严重的那一端。
   */
  const settingsEl = showSettings ? (
  <SettingsView
          value={appearance}
          onChange={updateAppearance}
          onClose={() => setShowSettings(false)}
          appVersion={appVersion}
          onCheckUpdate={checkUpdateNow}
          prefs={prefs}
          onPrefsChange={updatePrefs}
          sync={{
            server: state.account?.serverUrl ?? null,
            account: state.account?.email ?? null,
            syncing,
            onSyncNow: () => void doSync(),
            onOpenLogin: () => {
              setShowSettings(false);
              setShowLogin(true);
            },
            onAddDevice: () => void showPairCode(),
          }}
          storage={{
            // opfs:// 是虚拟标记，对用户来说就是「应用内部存储」，不该把它当路径显示
            // content:// 那一长串给人看等于没说，有显示名就用显示名
            path:
              vault?.localPath && !vault.localPath.startsWith('opfs://')
                ? vault.localLabel ?? vault.localPath
                : null,
            fileCount: allPaths.length,
            // v0.10.4：安卓有自己的 SAF 选择器了，不再是"只有桌面能选"
            canPick: isTauri,
            isAndroid: isAndroidUA(),
            onPick: () => void onBindFolder(),
            onUnbind: () => void onUnbindFolder(),
          }}
          agentSection={
            <AgentSection
              client={client}
              serverUrl={state.account?.serverUrl ?? null}
              toast={toast}
              errText={errText}
            />
          }
        />
  ) : null;

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
        {showSyncStatus && (
          <SyncStatusPanel
            loading={syncStatusBusy}
            list={syncStatusList}
            summary={summarize(syncStatusList)}
            errors={lastReport?.errors ?? []}
            syncing={syncing}
            onRefresh={() => void refreshSyncStatus()}
            onSyncNow={async () => {
                await doSync();
                await refreshSyncStatus();
            }}
            onOpen={(p) => {
                setShowSyncStatus(false);
                void openFileInTab(p);
            }}
            onClose={() => setShowSyncStatus(false)}
          />
        )}
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
        preferPairing={isMobile}
      />
    );
  }

  // 未登录：列表里展示全部**本地**库（负数 id）；云端库要登录后才能用
  const vaultList = Object.values(state.vaults).filter((v) => state.account || v.id < 0);

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
          emptyDirs={emptyDirs}
          searchDocs={searchDocs}
          onOpenTags={() => void openTagPanel()}
          searchSeed={mobileSearchSeed}
          onRequestMove={(p, isDir) => setMoving({ path: p, isDir })}
          onCreateFolder={(parent) => void onCreateFolder(parent ?? '')}
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
          onCheckUpdate={checkUpdateNow}
          onSync={() => void doSync()}
          onCreateVault={createVault}
          theme={theme}
          onToggleTheme={toggleTheme}
          onLogout={onLogout}
          hasAccount={!!state.account}
          onOpenLogin={() => setShowLogin(true)}
          syncDisabled={!state.account}
          sortMode={sortMode}
          onSortChange={setSortMode}
          onOpenPdf={(p) => void onOpenPdf(p)}
          onInsertImage={onInsertImage}
          resolveImage={resolveImage}
          onOpenPath={onOpenLinkPath}
          onOpenSettings={() => setShowSettings(true)}
        />
        {/* 标签面板原本整段写在桌面分支之后，手机上根本不渲染——补入口就得连它一起搬 */}
        {showTagPanel && (
          <TagPanel
            docs={searchDocs}
            onClose={() => setShowTagPanel(false)}
            onPick={(tag) => {
              setShowTagPanel(false);
              setMobileSearchSeed((cur) => ({ text: '#' + tag, n: (cur?.n ?? 0) + 1 }));
            }}
          />
        )}
        {moving && (
          <MoveDialog
            srcPath={moving.path}
            isDir={moving.isDir}
            dirs={allDirs}
            onClose={() => setMoving(null)}
            onPick={(destDir) => {
              const m = moving;
              setMoving(null);
              void onMovePath(m.path, destDir, m.isDir);
            }}
          />
        )}
        {settingsEl}
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
          onToggleTheme={toggleTheme}
          onBindFolder={() => undefined}
          onUnbindFolder={() => undefined}
          onLogout={onLogout}
          hasAccount={!!state.account}
          onOpenLogin={() => setShowLogin(true)}
          syncDisabled={!state.account}
          sortMode={sortMode}
          onSortChange={setSortMode}
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
        emptyDirs={emptyDirs}
        splitPath={splitPath}
        splitDoc={splitDoc}
        onOpenSplit={(p) => void openSplit(p)}
        onRequestMove={(p, isDir) => setMoving({ path: p, isDir })}
        onRenameFile={(p, name) => void onRenameFile(p, name)}
        jumpTo={jumpTo}
        defaultView={prefs.defaultView}
        livePreviewOn={prefs.livePreview}
        onOpenSyncStatus={openSyncStatus}
        onOpenAt={(p, line) => {
          void openFileInTab(p);
          setJumpTo((cur) => ({ path: p, line, n: (cur?.n ?? 0) + 1 }));
        }}
        onCloseSplit={closeSplit}
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
        onMovePath={(src, dest, isDir) => void onMovePath(src, dest, isDir)}
        onRequestRename={(p) => void requestRename(p)}
        onCopyPath={(p) => void copyPath(p)}
        onSyncNow={() => void doSync()}
        onUpload={() => void doUpload()}
        onDownload={() => void doDownload()}
        onImportObsidian={() => void onImportObsidian()}
        tabs={openTabs}
        activeTab={activeTab}
        onSelectTab={(p) => void openFileInTab(p)}
        onCloseTab={closeTab}
        theme={theme}
        onToggleTheme={toggleTheme}
        onBindFolder={() => void onBindFolder()}
        onUnbindFolder={onUnbindFolder}
        onLogout={onLogout}
        hasAccount={!!state.account}
        onOpenLogin={() => setShowLogin(true)}
        syncDisabled={!state.account}
        sortMode={sortMode}
        onSortChange={setSortMode}
        onOpenPdf={(p) => void onOpenPdf(p)}
        pdfView={pdfView}
        onClosePdf={onClosePdf}
        onInsertImage={onInsertImage}
        resolveImage={resolveImage}
        importProgress={importProgress}
        trashCount={trash.list.length}
        onOpenTrash={() => void trash.reload()}
        collapsedDirs={collapsedDirs}
        onToggleDir={toggleDir}
        onCreateFolder={(parent) => void onCreateFolder(parent ?? '')}
        conflictCount={conflictFiles.length}
        onOpenTags={() => void openTagPanel()}
        onOpenSettings={() => setShowSettings(true)}
        searchDocs={searchDocs}
        onPasteImage={onPasteImage}
        onOpenGraph={() => {
          setShowGraph(true);
        }}
        onOpenWiki={(t) => void onOpenWiki(t)}
        onOpenPath={onOpenLinkPath}
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
              onClosePdf();
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
          recent={recent}
          commands={commands}
          onOpenNote={(p) => void openFileInTab(p)}
          onClose={closePalette}
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
        <TagPanel
          docs={searchDocs}
          onClose={() => setShowTagPanel(false)}
          onPick={(tag) => {
            setShowTagPanel(false);
            searchTag(tag);
          }}
        />
      )}
      {pairInfo && (
        /*
         * v0.10.3：**必须盖在设置面板之上**。配对码是从「设置 → 同步 → 生成配对码」
         * 点出来的，两个弹层都是 .dlg-mask（z-index 50），按 DOM 顺序设置卡片反而在上面——
         * 于是屏幕上唯一要读的那串数字被压在毛玻璃后面看不清。
         */
        <div
          className="dlg-mask dlg-mask-top"
          onMouseDown={(e) => e.target === e.currentTarget && setPairInfo(null)}
        >
          <div className="dlg-card trash-card" role="dialog" aria-modal="true" aria-label="添加设备">
            <h2 className="dlg-title">添加设备</h2>
            <p className="dlg-desc">
              在新设备（手机 / 另一台电脑）上打开 Ivyea Note，选「配对码」，
              把下面这 6 位数字填进去就行——不用输服务器地址，也不用输密码。
            </p>
            <div className="pair-code">{pairInfo.code}</div>
            {/* v0.10.0 定的规矩是清掉装饰性 emoji（字形在各平台不一致，Windows 上还会变黑白），这里漏了一个 */}
            <p className="dlg-desc">{pairInfo.expiresIn} 秒内有效，仅可使用一次</p>
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
      {settingsEl}
      {trash.open && (
        <div className="dlg-mask" onMouseDown={(e) => e.target === e.currentTarget && trash.setOpen(false)}>
          <div className="dlg-card trash-card" role="dialog" aria-modal="true" aria-label="回收站">
            <h2 className="dlg-title">回收站</h2>
            {trash.list.length === 0 ? (
              <p className="dlg-desc">回收站是空的。</p>
            ) : (
              <ul className="trash-list">
                {trash.list.map((p) => (
                  <li key={p} className="trash-item">
                    <span className="ti-name" title={p}>
                      {p.replace(/^\.trash\//, '')}
                    </span>
                    <button className="btn ghost" onClick={() => void trash.restore(p)}>
                      恢复
                    </button>
                    <button className="btn danger" onClick={() => void trash.purge(p)}>
                      彻底删除
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="dlg-actions">
              <button className="btn primary" onClick={() => trash.setOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
      {moving && (
        <MoveDialog
          srcPath={moving.path}
          isDir={moving.isDir}
          dirs={allDirs}
          onClose={() => setMoving(null)}
          onPick={(destDir) => {
            const m = moving;
            setMoving(null);
            void onMovePath(m.path, destDir, m.isDir);
          }}
        />
      )}
      {showSyncStatus && (
        <SyncStatusPanel
          loading={syncStatusBusy}
          list={syncStatusList}
          summary={summarize(syncStatusList)}
          errors={lastReport?.errors ?? []}
          syncing={syncing}
          onRefresh={() => void refreshSyncStatus()}
          onSyncNow={async () => {
            await doSync();
            await refreshSyncStatus();
          }}
          onOpen={(p) => {
            setShowSyncStatus(false);
            void openFileInTab(p);
          }}
          onClose={() => setShowSyncStatus(false)}
        />
      )}
      {dialogEl}
      {toastEl}
    </div>
  );
}

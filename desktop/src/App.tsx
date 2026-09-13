import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LoginView } from './ui/LoginView';
import { SetupGuide } from './ui/SetupGuide';
import { MainView, type SidebarTab } from './ui/MainView';
import { renderMarkdown, resolveImagesIn, type SelectionApi } from './ui/MarkdownEditor';
import { AiPanel } from './ui/AiPanel';
import {
  AI_ACTIONS,
  askNoteSpec,
  askVaultSpec,
  buildMessages,
  buildVaultContext,
  chat,
  cleanReply,
  customSpec,
  expandQueryMessages,
  isLlmConfigured,
  recapSpec,
  savedSpec,
  streamChat,
  type AiActionSpec,
} from './lib/llm';
import { retrieve, totalChars } from './lib/retrieve';
import { mergeTags, parseTagReply } from './lib/noteTags';
import { buildRecapSource, pickRecent, startOfDay, startOfWeek } from './lib/recap';
import { aiSubmenu } from './lib/editorMenu';
import { tidyMarkdown, describeTidy } from './lib/tidy';
import { pickDensity } from './lib/density';
import { isSameTitle } from './ui/InlineTitle';
import { MobileView } from './ui/MobileView';
import { useDialog } from './ui/Dialog';
import { useUpdater } from './hooks/useUpdater';
import { useTabs, NEW_TAB } from './hooks/useTabs';
import { useCommands } from './hooks/useCommands';
import { useAttachments } from './hooks/useAttachments';
import { useObsidianImport } from './hooks/useObsidianImport';
import { useTemplates } from './hooks/useTemplates';
import { useLauncher, type Launcher } from './hooks/useLauncher';
import { useVaultFiles } from './hooks/useVaultFiles';
import { useSyncEngine } from './hooks/useSyncEngine';
import { useTrash, trashPathFor, nextTrashName } from './hooks/useTrash';
import { useFileHistory } from './hooks/useFileHistory';
import type { DeletedFile } from './lib/api';
import type { RightTab } from './ui/RightPanel';
import { useToast } from './ui/Toast';
import { allowVaultPath } from './lib/fsScope';
import { linkVaults } from './lib/vaultLink';
import { baseNameOf, openWithSystem } from './lib/openExternal';
import { TopBar, type QuickAction } from './ui/TopBar';
import type { MenuItem } from './ui/ContextMenu';
import { WelcomeView, isWelcomed } from './ui/WelcomeView';
import { ApiError, SyncClient, sha256Hex } from './lib/api';
import type { FileIO } from './lib/sync';
import { tauriIO, opfsIO, migrateFiles, removeOpfsVault } from './lib/fs-adapters';
import { vaultDisplayName, vaultLocationLabel, folderName } from './lib/vaultName';
import { extractH1, replaceFirstH1, titleToPath, uniqueName, sanitizeTitle } from './lib/titleSync';
import { loadCollapsed, saveCollapsed } from './ui/FileTree';
import { Palette } from './ui/Palette';
import { TagPanel } from './ui/TagPanel';
import { MoveDialog } from './ui/MoveDialog';
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
import { loadLastOpen, pickRestore, saveLastOpen } from './lib/lastOpen';
import { invertMoveOps, planMove, planRenameDir, remapDirKeys, remapPath } from './lib/movePath';
import { noteCandidates } from './lib/links';
import {
  isSafPath,
  pickVaultFolder,
  safIO,
  takePendingPick,
  rememberPendingPick,
  readPendingPick,
  clearPendingPick,
} from './lib/saf';
import {
  localServerAvailable,
  localServerStatus,
  startLocalServer,
  stopLocalServer,
  isLocalServerAccount,
  type LocalServerInfo,
} from './lib/localServer';
import {
  classifyVault,
  originalOfConflict,
  summarize,
  type FileSyncStatus,
} from './lib/syncStatus';
import { extractLinks, titleOfPath } from './lib/wikilink';
import { toggleTaskLine } from './lib/todoTasks';
import {
  loadState,
  saveState,
  clearAccount,
  ensureLocalVault,
  LOCAL_VAULT_ID,
  newVaultMeta,
  nextLocalVaultId,
  type PersistState,
  type Tokens,
  type VaultMeta,
  loadActiveVaultId,
  saveActiveVaultId,
  commitLedger,
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
  const [vaultId, setVaultId] = useState<number | null>(loadActiveVaultId);
  /** v0.3.4：PDF 列表与元数据（排序） */
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  /**
   * 阅读 / 编辑视图模式。**由 App 持有**，顶栏那个开关和编辑器共用同一份——
   * MarkdownEditor 本来就支持受控 `mode`（移动端一直这么用）。
   * 不这么做的话顶栏只能靠合成一个 Ctrl+E 键盘事件去戳编辑器，那是个脆弱的桥。
   */
  const [viewMode, setViewMode] = useState<'edit' | 'read'>('edit');
  /** 同步拉取后要重读当前文件，但 currentPath 不能进 useSyncEngine 的依赖——
   *  否则每切换一次笔记就重建一次同步引擎。用 ref 旁路。 */
  const currentPathRef = useRef<string | null>(null);
  currentPathRef.current = currentPath;
  const splitPathRef = useRef<string | null>(null);
  const [doc, setDoc] = useState<string | null>(null);
  /**
   * v0.8.2 E9：编辑区左右分栏。第二个窗格自带路径与内容——
   * `splitPath === currentPath` 就是「同文档双视图」，不同则是「两文档并排」。
   */
  const [splitPath, setSplitPath] = useState<string | null>(null);
  const [splitDoc, setSplitDoc] = useState<string | null>(null);
  /** v0.11.24：恢复历史版本前要把编辑器里还没落盘的内容先写下去，走 ref 不进依赖 */
  const docRef = useRef<string | null>(null);
  docRef.current = doc;
  const splitDocRef = useRef<string | null>(null);
  splitDocRef.current = splitDoc;
  splitPathRef.current = splitPath;
  const [showGuide, setShowGuide] = useState(false);
  /** 按需唤起的登录页（免登录模式下从侧栏打开） */
  const [showLogin, setShowLogin] = useState(false);
  /**
   * 登录态过期（refresh token 也被服务端拒了）。
   *
   * **不清账号**：`clearAccount()` 之后 `activeVaultId` 会掉回本地库，
   * 用户眼前那个云端库连同它绑定的磁盘目录会整个从界面上消失（笔记还在盘上，
   * 但界面回不去）。这里只标记状态：停掉自动同步、把「重新登录」摆到明面上，
   * 重新登录成功后 finishLogin 会把 vault 列表原样接回来。
   */
  const [sessionExpired, setSessionExpired] = useState(false);
  /** 侧边栏展开/收起。落盘——不落盘的话每次重启又弹回来，等于没做 */
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem('ivnote.sidebarOpen') !== '0'
  );
  const toggleSidebar = useCallback(() => {
    setSidebarOpen((v) => {
      localStorage.setItem('ivnote.sidebarOpen', v ? '0' : '1');
      return !v;
    });
  }, []);
  const expiredNotified = useRef(false);
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

  // 选中的库要跟着落盘，否则下次启动又回到"没选库"
  useEffect(() => {
    saveActiveVaultId(vaultId);
  }, [vaultId]);

  /**
   * 兜底选库：登录着、却没有一个有效的选中库时，自动挑一个。
   * 这条路会在三种情况下走到——第一次登录完、存下的库在服务端被删了、
   * 以及升级上来的老用户（他们的 localStorage 里根本没有这个键）。
   * 没有它，界面就停在 `!vault` 那个什么都点不动的空壳上。
   */
  useEffect(() => {
    if (!state.account) return;
    if (vaultId && state.vaults[String(vaultId)]) return;
    const ids = Object.keys(state.vaults)
      .map(Number)
      .filter((n) => Number.isFinite(n))
      // 云端库（正数 id）优先：登录之后本地库通常已经并进去了
      .sort((a, b) => (a > 0 ? 0 : 1) - (b > 0 ? 0 : 1) || a - b);
    if (ids.length > 0) setVaultId(ids[0]);
  }, [state.account, state.vaults, vaultId]);

  /*
   * v0.11.4：**每次激活一个磁盘上的笔记库，都把它递归加进 fs 作用域。**
   *
   * 不做这件事的后果极其隐蔽：已有笔记读写全正常，唯独在子目录里新建附件被拒
   * （`forbidden path: …`）。因为绑定文件夹那次的作用域是对话框插件顺手给的，
   * 而它只放行库根那一层。「粘贴图片没反应」连报四轮，根因就在这儿。
   * 放在这里而不是"绑定文件夹"那一处：每次启动恢复上次的库时同样需要。
   */
  useEffect(() => {
    void allowVaultPath(vault?.localPath);
  }, [vault?.localPath]);

  // 换一篇笔记就回到设置里的默认视图（此前这件事在 MarkdownEditor 内部做，
  // 模式提上来之后要跟着提上来，否则打开新笔记会停在上一篇的视图）
  useEffect(() => {
    setViewMode(prefs.defaultView ?? 'edit');
  }, [currentPath, prefs.defaultView]);

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
    allFiles,
    mdStamps,
    emptyDirs,
    allPaths,
    metaOf,
    sortMode,
    setSortMode,
    refresh: refreshFiles,
    loaded: filesLoaded,
  } = useVaultFiles(io, vault ? (vault.localPath ?? '') : null);

  /**
   * v0.11.24：文件历史。写盘前留本机快照 + 列云端每一版（hooks/useFileHistory）。
   * 用户：「被误修改的可真就无法找回了」——现在找得回。
   */
  const fileHistory = useFileHistory({
    io,
    vaultPath: vault ? (vault.localPath ?? '') : null,
    vaultId: vault?.id ?? null,
    client,
    deviceId: state.account?.deviceId,
    allPaths,
  });
  /** 命令面板 / 状态栏想让右栏切到某个标签（MainView 消费后清掉） */
  const [wantRightTab, setWantRightTab] = useState<RightTab | null>(null);


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

  /**
   * v0.11.15：**`.base` 视图要看到库里的全部文件，不只是笔记。**
   *
   * 此前喂给它的是 `searchDocs`——那是**正文索引**，只含 `.md`。于是一张按文件夹
   * 筛选的表里，图片、PDF、乃至这个 `.base` 文件自己全都不见（用户原话：
   * 「个人空间统计不完全啊，图片，pdf，个人空间本身的 .base 文件都没有在个人
   * 空间里面体现」）。Obsidian 的 Bases 数据源是"库里的文件"，不是"库里的笔记"。
   *
   * 非笔记没有正文，`content` 给空串即可：`buildCtx` 由此得到空的 frontmatter
   * 与空的标签/链接，而 `file.name / ext / folder / mtime / size` 照常可用——
   * 按文件夹、按扩展名筛选的表因此立刻完整。
   */
  const baseFiles = useMemo(() => {
    const text = new Map(searchDocs.map((d) => [d.path, d.content]));
    return allFiles.map((path) => {
      const m = metaOf(path);
      return { path, content: text.get(path) ?? '', mtime: m?.mtime, size: m?.size };
    });
  }, [allFiles, searchDocs, metaOf]);


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

  /**
   * 外部（Obsidian / VSCode / 另一台设备）改了磁盘上的文件 → 把**正在打开的那篇**
   * 重新读进编辑区。
   *
   * 文件监听此前只调 `refreshFiles()`，而它刷的是文件列表和索引、**从不碰 `doc`**。
   * 于是外部改动的表现是：侧栏里新文件会冒出来，你正开着的那篇却一直是旧内容，
   * 非得切走再切回来才看得到。编辑器一侧的「外部改动回灌」v0.9.1 就写好了
   * （`MarkdownEditor` 认 props.doc 的变化并尽量保住光标），缺的一直是有人去 `setDoc`。
   *
   * 有未落盘的本地编辑就不覆盖：`saveTimers` 里还挂着这条路径 = 用户刚敲完还没写盘，
   * 这时候拿磁盘内容盖上去就是吃掉刚敲的字。
   */
  const reloadExternal = useCallback(async () => {
    if (!vault) return;
    const root = vault.localPath ?? '';
    const cur = currentPathRef.current;
    const spl = splitPathRef.current;
    if (cur && !saveTimers.current.has(cur)) {
      try {
        const text = await io.read(root, cur);
        setDoc((prev) => (prev === text ? prev : text));
      } catch {
        // 被外部删了/改名了：列表刷新会把它从树里去掉，这里不动编辑区
      }
    }
    if (spl && spl !== cur && !saveTimers.current.has(spl)) {
      try {
        const text = await io.read(root, spl);
        setSplitDoc((prev) => (prev === text ? prev : text));
      } catch {
        /* 同上 */
      }
    }
  }, [vault, io]);
  /** 给文件监听用：走 ref 才不会每次 doc 变化都重装一次 watcher */
  const reloadExternalRef = useRef(reloadExternal);
  reloadExternalRef.current = reloadExternal;

  /**
   * 把当前这个「服务端不认的库」重新接到云端。
   *
   * 登录时的那次协调只跑一次、失败即永久留坑（见 finishLogin 的注释）。
   * 这条路让同步引擎在拿到 403 的当下就能自己救回来，用户不需要知道
   * 「退出登录再登一次」这种内部知识。
   */
  const relinking = useRef(false);
  const relinkFailedOnce = useRef(false);
  const relink = useCallback(async (quiet = false): Promise<boolean> => {
    if (!client || relinking.current) return false;
    relinking.current = true;
    try {
      const r = await linkVaults(client, stateRef.current, loadActiveVaultId());
      persist({ ...stateRef.current, vaults: r.vaults });
      if (r.activeId !== null) setVaultId(r.activeId);
      if (r.linked) {
        toast(
          r.linked.copied > 0
            ? `已把「${r.linked.name}」接入云端（${r.linked.copied} 篇笔记）`
            : `已把「${r.linked.name}」接入云端笔记库`,
          'ok'
        );
      }
      for (const g of r.released) {
        toast(
          g.keptAs !== null
            ? `「${g.name}」已在别的设备上删除；这台设备上的内容留成了本地库`
            : `「${g.name}」已在别的设备上删除，已从列表移除（文件不动）`,
          'info'
        );
      }
      relinkFailedOnce.current = false;
      return true;
    } catch (e) {
      // 每次同步都会重试，所以提示只出一次——底下的同步失败横幅一直都在，不算静默。
      // 启动时那次对齐（quiet）连这一次都不出：没网打开应用不该先弹一条红的。
      if (!relinkFailedOnce.current && !quiet) {
        relinkFailedOnce.current = true;
        toast(`云端笔记库没接上：${errText(e)}`, 'error');
      }
      return false;
    } finally {
      relinking.current = false;
    }
  }, [client, persist, toast]);

  /**
   * 导出为 PDF。
   *
   * 走的是**系统打印**（WebView2 / WebKitGTK 的打印对话框里选「另存为 PDF」），
   * 不自己塞一个 PDF 生成库：排版结果和阅读视图一模一样、中文字体不用另外内嵌，
   * 也不用为了一个功能多背几百 KB 依赖。打印样式在 index.css 的 `@media print` 里，
   * 那段把界面（侧栏/顶栏/状态栏）全部藏掉，只留正文。
   *
   * 必须先切到阅读视图：编辑器是虚拟滚动的，只渲染视口内那几行——直接打印
   * 会得到一份**只有一屏内容**的 PDF（这正是"看起来能用其实是坏的"那种功能）。
   */
  /** 在系统文件管理器里定位到这篇笔记（Obsidian 的「在系统资源管理器中显示」） */
  const revealCurrent = useCallback(
    async (rel: string) => {
      const root = vault?.localPath;
      if (!root || root.startsWith('opfs://')) return;
      try {
        const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
        await revealItemInDir(`${root.replace(/\/$/, '')}/${rel}`);
      } catch (e) {
        toast(`定位失败：${errText(e)}`, 'error');
      }
    },
    [vault?.localPath, toast]
  );

  /**
   * 导出为 PDF（v0.11.16 重做）。
   *
   * 用户原话：「为什么导出为 PDF 还需要链接打印机？这跟我的需求不一样啊，
   * 我的需求是直接能转成 PDF 文件」。此前这里只有一句 `window.print()`——
   * 弹的是系统打印对话框，得在里面挑一个叫「Microsoft Print to PDF」的虚拟打印机。
   *
   * 现在 Windows 上走 WebView2 的 `PrintToPdf`：选个保存位置，直接落一个 PDF 文件，
   * 出来的还是**矢量**的（文字能选中、能搜索、简历筛选系统能解析），
   * 而不是把页面截成图拼出来的那种。
   * 其它平台没有这条原生路，仍然退回打印对话框（macOS 的打印面板自带「存储为 PDF」），
   * 而且**先问支不支持再决定要不要弹保存框**——不能让人选完位置才说做不到。
   */
  const onAuthExpired = useCallback(() => {
    setSessionExpired(true);
    if (!expiredNotified.current) {
      expiredNotified.current = true;
      toast('登录已过期，请重新登录后继续同步', 'error');
    }
  }, [toast]);

  const {
    syncing,
    lastReport,
    setLastReport,
    sync: doSync,
    autoSync: doAutoSync,
    syncAllowingDeletes,
    upload: doUpload,
    download: doDownload,
  } = useSyncEngine({
    client,
    vault: vault ?? null,
    io,
    deviceId: state.account?.deviceId,
    refresh: refreshFiles,
    persist: (used) => {
      /*
       * v0.11.28：同步引擎改的是它闭包里那个 VaultMeta；如果这期间 state 里同一个库已经
       * 换成了别的对象（任何克隆），就把账本六个字段搬过去再落盘，否则这一轮的
       * 墓碑/附件哈希/游标就丢了（见 lib/vaultLink 里的注释）。
       */
      const cur = stateRef.current;
      const live = cur.vaults[String(used.id)];
      if (live) commitLedger(live, used);
      persist({ ...cur });
    },
    afterPull,
    errText,
    onUnlinked: relink,
    onAuthExpired,
  });

  /*
   * 登录着、可 state 里**一个云端库都没有** —— 说明登录那次的协调根本没跑成
   * （v0.11.5 的 CORS 故障留下的正是这种状态）。补这一脚，老用户升级上来
   * 打开就自己好了，不用先撞一次同步失败。
   */
  const healed = useRef(false);
  useEffect(() => {
    if (!client || healed.current) return;
    healed.current = true;
    /*
     * v0.11.25 起登录着就**每次启动对齐一次**库清单（不只是"一个云端库都没有"时）：
     * 别的设备删掉的库要从这台设备的列表里消失，靠"等它被选中、同步撞 403"太晚——
     * 测试用的空库永远不会被选中，就永远挂在那儿。当前库服务端认得时 linkVaults
     * 什么都不动（pickOrphan 返回 null），只是把列表对齐。
     */
    void relink(true);
  }, [client, relink]);

  // ---------- v0.3.4：插图 / 图片解析 / PDF（v0.8.0 P1.4 搬进 hooks/useAttachments） ----------

  const onShowPdf = useCallback(() => {
    // PDF 与笔记在主区互斥：先把编辑器清干净
    setCurrentPath(null);
    setDoc(null);
  }, []);
  const {
    pdfView,
    pdfPath,
    insertImage: onInsertImage,
    saveImageFile: onPasteImage,
    resolveImage,
    openPdf: onOpenPdf,
    openWithSystemApp,
    closePdf: onClosePdf,
  } = useAttachments({
    vaultPath: vault ? vault.localPath ?? '' : null,
    io,
    refreshFiles,
    doSync: () => void doSync(),
    toast,
    onShowPdf,
    errText,
    attachMode: prefs.attachMode,
  });


  /**
   * 导出为 PDF（v0.11.17 重做第二版）。
   *
   * # 上一版错在哪
   *
   * v0.11.16 是"切到阅读视图 → 让 WebView2 把**当前页面**打成 PDF"。用户拿到的是
   * 「只有第一页有字、总页数还多出一大堆」。我把他同步到服务器上的那份
   * `IvyeaNote.pdf` 捞下来数过：**78 页里 77 页是全空的**（内容流 0 字节），
   * 第 1 页正好是一屏的量。
   *
   * 真因不止一个，全是"拿应用外壳去打印"带来的：
   * ① 打印样式里那条 `.editor-host { display:block !important }` 会把**阅读模式下
   *    靠 inline `display:none` 藏起来的 CodeMirror 又拽回来**——它是虚拟滚动的，
   *    DOM 里只有视口那一屏，高度却是整篇的，于是"页数够、字只有一页"；
   * ② `html, body { height: 100% }` 在打印里就是"一页纸那么高"，正文溢出后不参与分页；
   * ③ 正文到 body 之间全是 flex 容器，而 Chromium **不会把 flex item 拆到下一页**。
   *
   * # 这一版怎么做
   *
   * 干脆**不打应用外壳**：把当前笔记单独渲染成一份干净的文档（只有正文），
   * 打印时把整个 `#root` 藏掉、只留它。这个形状是拿 CDP 真的打出 PDF、
   * 逐页数过字数验证的（9 页 9 页都有字），而不是"看着应该行"。
   * 顺带它还解决了另外两件事：在编辑模式直接 Ctrl+P 也能出完整的 PDF，
   * 以及导出的内容不再受侧栏/分栏/右栏这些跟正文无关的布局影响。
   */
  const exportPdf = useCallback(async () => {
    if (!currentPath || doc === null) return;
    const title = titleOfPath(currentPath);
    const host = document.createElement('div');
    host.id = 'print-doc';
    host.className = 'md-preview print-doc';
    /*
     * 文件名即标题（应用里它是正文上方那一层，不在 md-preview 里）。
     * 正文首行已经是同一个标题时不再顶一行——和内联标题那条去重规则同源。
     */
    const body = renderMarkdown(doc);
    host.innerHTML = isSameTitle(title, doc)
      ? body
      : `<h1>${title.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c)}</h1>${body}`;
    document.body.appendChild(host);
    document.documentElement.classList.add('printing');
    const fallbackPrint = () => {
      try {
        window.print();
      } catch (e) {
        toast(`导出失败：${errText(e)}`, 'error');
      }
    };
    try {
      // 图片要和阅读视图同一套解析规则，否则导出的 PDF 里全是"图片加载失败"
      await resolveImagesIn(host, currentPath, resolveImage);
      // 让浏览器把这份文档真的排一遍版再打印（两帧足够提交 + 排版）
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (!isTauri) {
        fallbackPrint();
        return;
      }
      const { invoke } = await import('@tauri-apps/api/core');
      const native = await invoke<boolean>('export_pdf_supported');
      if (!native) {
        toast('这个平台还没有原生导出，已打开打印面板（在里面选「另存为 PDF」）', 'ok');
        fallbackPrint();
        return;
      }
      const { save } = await import('@tauri-apps/plugin-dialog');
      const target = await save({
        defaultPath: `${title}.pdf`,
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (!target) return; // 用户自己取消了，不该弹任何提示
      await invoke('export_pdf', { path: target });
      toast(`已导出 PDF：${target}`, 'ok');
    } catch (e) {
      // 失败要说得出原因，并且留一条能走的路——静默失败这个仓库付过四轮返工的账
      toast(`导出 PDF 失败：${errText(e)}；已改用打印面板`, 'error');
      fallbackPrint();
    } finally {
      // 无论走哪条路都要收拾干净：这份文档留在 body 里会让下一次打印重影
      document.documentElement.classList.remove('printing');
      host.remove();
    }
  }, [currentPath, doc, resolveImage, toast, errText]);

  // ---------- 登录 / 注册 ----------

  const finishLogin = useCallback(
    async (serverUrl: string, email: string, userId: number, access: string, refresh: string) => {
      /*
       * 令牌轮换**必须接住**。这两个临时 client 以前传的是 `() => undefined`：
       * 一旦中间发生 401 自动刷新，服务端会把旧 refresh token 删掉、发一个新的，
       * 而新的被这里当场扔了 —— 存进 state 的那个已经作废，之后每一次刷新都是
       * 「refresh token 无效或已过期」，除了重新登录没有别的出路。
       */
      let live: Tokens = { access, refresh };
      const keepTokens = (t: Tokens) => {
        live = t;
      };
      // 先用临时 client 注册设备，拿到 device_id 后再落盘
      let deviceId = '';
      try {
        const tmp = new SyncClient(serverUrl, live, keepTokens);
        deviceId = (await tmp.registerDevice()).device_id;
      } catch {
        deviceId = `local-${crypto.randomUUID()}`; // 注册失败不阻塞登录
      }
      const cur = loadState();
      /*
       * 与服务端对齐 vault 列表、把本地库接上云端。**协调本身失败也不能算登录失败**，
       * 但也不能像以前那样一 catch 了事：state 里留着一个负数 id 的库、account 却
       * 存下了，之后每一轮同步都是 403，而且不重新登录就永远不会再协调第二次
       * （v0.11.5 的 CORS 故障就是这么把用户卡死的）。现在同一段逻辑还挂在
       * `relink()` 上，登录之后随时能自己接回来。
       */
      let vaults = cur.vaults;
      let activeId: number | null = null;
      try {
        const c = new SyncClient(serverUrl, live, keepTokens, deviceId);
        const r = await linkVaults(c, cur, loadActiveVaultId() ?? LOCAL_VAULT_ID);
        vaults = r.vaults;
        activeId = r.activeId;
      } catch {
        // 连不上服务器：本地库原样留着，交给 relink 那条自愈路径
      }
      const acc = { serverUrl, email, userId, deviceId, tokens: live };
      persist({ account: acc, vaults });
      setVaultId(activeId ?? Object.values(vaults)[0]?.id ?? null);
      setSessionExpired(false);
      expiredNotified.current = false;
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

  /*
   * v0.11.11：启动后回到退出前那篇笔记。
   *
   * 放在"文件列表就绪之后"而不是"库就绪之后"：记下的路径可能已经被删/改名，
   * 必须拿真实文件列表校验过再打开，否则会打开一个不存在的路径然后弹报错。
   * 只在 currentPath 还空着时做——用户已经点开别的了就不要抢。
   */
  const restoredFor = useRef<number | null>(null);
  useEffect(() => {
    if (!vault || files.length === 0) return;
    if (restoredFor.current === vault.id) return;
    // 库里已经没有的标签先清掉（换库、外部删除都会留下死标签）
    pruneTabs(files);
    /*
     * v0.11.30：从桌面快捷方式 / 小部件进来时让路。那边马上要新建或打开某一篇，
     * 这里再还原上次那篇就是两个 openFile 赛跑，谁后读完谁赢。先不还原也不记"已还原"：
     * 那个动作若没开成任何东西（比如要开的笔记已删），下一次列表变化仍会回到这里补上。
     */
    if (launcherRef.current?.hasPendingAction()) return;
    restoredFor.current = vault.id;
    const target = pickRestore(loadLastOpen(vault.id), files, currentPath);
    // 走 openFileInTab 而不是 openFile：还原的那篇也该出现在标签栏里
    if (target) void openFileInTab(target);
    // openFile / currentPath 故意不进依赖：这一次还原只该发生一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault, files]);

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
    // 登录态过期时不再自动重试：refresh 已经废了，重试一万次也是同一条错，
    // 只会把红条刷得更频繁。等用户重新登录。
    if (!client || !prefs.autoSync || sessionExpired) return;
    /*
     * v0.11.14：这四个时机走 `doAutoSync`——没人点过任何按钮，一次网络抖动就
     * 不该在正文上方贴一段带排查提示的红字。手机上「刚解锁 / 切回前台 / VPN
     * 正在重连」恰好全落在这些时机上（见 useSyncEngine 的 quiet）。
     */
    const timer = window.setTimeout(() => void doAutoSync(), 2000); // 启动拉取一次
    const onVisible = () => {
      if (document.visibilityState === 'visible') void doAutoSync();
    };
    // 网络回来的那一刻补一次：否则要等下一轮 60s 轮询，中间那段一直显示"离线"
    const onOnline = () => void doAutoSync();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    window.addEventListener('online', onOnline);
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') void doAutoSync();
    }, 60_000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, [client, prefs.autoSync, doAutoSync, sessionExpired]);

  /*
   * Ctrl+\\ 收起 / 展开侧边栏（和 Obsidian 同一个键位）。
   * 顶栏那颗按钮的提示里写了这个键——写了就必须真的能用，否则又是一处
   * 「看起来有、其实没有」。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key !== '\\') return;
      e.preventDefault();
      toggleSidebar();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleSidebar]);

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
            void reloadExternalRef.current();
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

  /*
   * 回到前台就对一次账。
   *
   * 系统级文件监听并不总是有：安卓的 SAF 树没有 watch，桌面上它也可能因为平台/权限
   * 悄悄起不来（`watch` 失败只有一行 console.warn）。而「切到 Obsidian 改一改、
   * 切回来」正是最常见的动作——**这条路不依赖任何原生能力，只是重读一遍**，
   * 是外部改动能被看见的兜底保证。
   */
  useEffect(() => {
    if (!vault?.localPath) return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void refreshFiles();
      void reloadExternalRef.current();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [vault?.localPath, refreshFiles]);

  // ---------- 文件操作 ----------

  /** v0.7.10 E6：最近打开，供快速切换器排序 */
  const [recent, setRecent] = useState<string[]>(loadRecent);
  /**
   * v0.11.30：安卓桌面入口（快捷方式 / 小部件）。hook 本身要等 openDailyNote 等声明完才能
   * 调（见下面 useLauncher 那段），而落盘 / 改名这两条更早的路径也要通知它，所以先留个 ref。
   * 非安卓平台上它的每个方法都是 no-op。
   */
  const launcherRef = useRef<Launcher | null>(null);

  /**
   * v0.11.22：正在主区里看的图片（`{路径, blob URL}`；null = 没在看图）。
   *
   * 声明在这儿而不是挨着 `onOpenAttachment`：`openFile` 打开笔记时要把它收起来
   * （主区一次只显示一样东西），而它得先存在。
   */
  const [imageView, setImageView] = useState<{ path: string; url: string } | null>(null);

  const openFile = useCallback(
    async (path: string) => {
      if (!vault) return;
      try {
        const text = await io.read(vault.localPath ?? '', path);
        onClosePdf();
        /*
         * v0.11.11：打开笔记时把 `.base` 表格收起来。
         *
         * 主区是三选一（表格 / PDF / 编辑器），而 `setBaseDoc` 只在"关闭"按钮里清过。
         * 于是从表里点一篇笔记之外的任何入口（侧栏、搜索、快速切换）都表现成
         * "点了没反应"——其实笔记已经打开了，只是被表格盖着。用户报的就是这个：
         * 「点击个人空间之后再点击别的文档不会跳转过去，需要手动点右上角的关闭才行」。
         */
        setBaseDoc(null);
        setHtmlDoc(null);
        setShowGraph(false); // 主区六选一：从图谱里点一篇笔记，图谱就该让位
        setImageView(null); // 图片同理：正看着图时点一篇笔记，图就该让位
        setCurrentPath(path);
        saveLastOpen(vault.id, path); // 下次启动直接回到这一篇
        setDoc(text);
        setRecent((cur) => {
          const next = pushRecent(cur, path);
          saveRecent(next);
          return next;
        });
      } catch (e) {
        /*
         * v0.11.16：**打不开就把这个标签摘掉**，别让它继续挂在顶栏上。
         *
         * 用户原话：「已经删除的文件为什么依然存在没有自动从顶部标签栏移除？
         * 点击的时候才有提示」。文件可能是在别处删的（Obsidian、另一台设备同步下来
         * 的删除），那种情况下面那条 effect 会兜住；这里管的是"点了才发现没了"——
         * 报一次原因，同时把它清掉，而不是每点一次报一次。
         */
        const gone = !(await io.exists(vault.localPath ?? '', path).catch(() => true));
        if (gone) {
          pruneTabsRef.current?.(path);
          toast(`「${titleOfPath(path)}」已经不在库里了，已从标签栏移除`, 'error');
        } else {
          toast(`打开失败：${errText(e)}`, 'error');
        }
      }
    },
    [vault, io, toast, onClosePdf]
  );

  /*
   * `openFile` 定义在 useTabs 之前（useTabs 要拿它当依赖），所以"关掉某个标签"
   * 只能通过 ref 回填。直接把 closeTab 提到上面会绕成循环依赖。
   */
  const pruneTabsRef = useRef<((path: string) => void) | null>(null);

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
    // 桌面小部件钉的也是路径，改名 / 移动同样要跟（v0.11.30；非安卓 no-op）
    launcherRef.current?.remapBindings(ops);
  }, []);

  /**
   * 顶栏标签页（v0.11.11 重新引入；v0.10.7 删掉的是"单独一整行的空栏"，不是标签本身）。
   * `openFileInTab` 这个名字沿用下来：所有"打开一篇笔记"的入口都走它。
   */
  const {
    tabs: openTabs,
    open: openFileInTab,
    openBlank: openBlankTab,
    activeNote: activeTab,
    close: closeTab,
    remap: remapTabs,
    prune: pruneTabs,
  } = useTabs({ openFile });

  /*
   * v0.11.16：**标签栏跟着文件列表走。**
   *
   * 启动时那次 `pruneTabs` 每个库只跑一次（restoredFor 守卫），所以此后不管是
   * 自己删的、别处删的、还是同步拉下来的删除，标签都会一直挂着，直到点它才报错。
   * 这里让它跟着每一次文件刷新对账。
   *
   * `allFiles.length === 0` 时**什么都不做**：换库/初次加载的一瞬间列表是空的，
   * 照着清会把所有标签一次抹掉——那是比留一个死标签严重得多的事故。
   */
  useEffect(() => {
    if (!vault || allFiles.length === 0) return;
    pruneTabs(allFiles);
  }, [vault, allFiles, pruneTabs]);

  useEffect(() => {
    pruneTabsRef.current = (path: string) => {
      closeTab(path);
    };
  }, [closeTab]);

  /**
   * v0.11.1：点开文件树里既不是笔记也不是 PDF 的东西。
   *
   * 文件树现在显示库里的**全部**文件（对齐 Obsidian），所以必须回答"点了会怎样"：
   * - 图片：在主区里看（v0.11.22 起；手机仍是全屏蒙层），不跳出去
   *   （附件本来就是笔记的一部分）；
   * - 其余（docx / zip / …）：交给系统应用。我们不打算自己渲染它们，
   *   假装能打开再弹个错，比直接交出去更糟。
   */
  /** v0.11.10：正在看的 `.base` 表格视图（主区与编辑器 / PDF 互斥） */
  const [baseDoc, setBaseDoc] = useState<{ path: string; text: string } | null>(null);
  /**
   * v0.11.18：正在看的 `.html`。
   *
   * 此前 `.html` 走 `openWithSystemApp`——点开就跳出应用去浏览器（用户点名）。
   * 现在在主区渲染（沙箱 iframe，不跑脚本），跳浏览器降级成工具条上的一个出口。
   */
  const [htmlDoc, setHtmlDoc] = useState<{ path: string; html: string } | null>(null);
  /**
   * v0.11.24：这个 HTML 允不允许跑脚本——「一律运行」或这个文件点过「运行脚本」。
   * 点「运行 / 停止」只改这个文件的记录；全局那档在设置里。
   */
  const htmlScriptsAllowed = htmlDoc
    ? prefs.htmlScripts === 'always' || prefs.htmlScriptFiles.includes(htmlDoc.path)
    : false;
  const onHtmlScriptsToggle = useCallback(
    (allow: boolean) => {
      if (!htmlDoc) return;
      const path = htmlDoc.path;
      const rest = prefs.htmlScriptFiles.filter((p) => p !== path);
      // 「一律运行」下点停止：只对这个文件不跑没法表达（列表是白名单），退回到「按文件」再把它去掉
      updatePrefs({
        ...prefs,
        htmlScripts: allow ? prefs.htmlScripts : 'ask',
        htmlScriptFiles: allow ? [...rest, path] : rest,
      });
    },
    [htmlDoc, prefs, updatePrefs]
  );
  /** HTML 工具的数据文件落盘：写完刷新列表（它是库里一个真文件）并推同步 */
  const writeVaultText = useCallback(
    async (rel: string, text: string) => {
      if (!vault) return;
      await io.write(vault.localPath ?? '', rel, text);
      await refreshFiles();
      if (prefs.autoSync) void doSync();
    },
    [vault, io, refreshFiles, prefs.autoSync, doSync]
  );
  const onOpenAttachment = useCallback(
    async (rel: string) => {
      /*
       * v0.11.10：`.base` 在应用里直接打开。
       *
       * 在此之前它走下面那条 `openWithSystemApp`——Windows 上没有程序关联
       * `.base`，于是只能退回"在文件夹中定位"，用户看到的就是「打不开」。
       * 它其实只是一份 YAML，描述"按条件筛库里的笔记，显示这几列"，
       * 数据全在本地，没有任何理由非得让 Obsidian 来读。
       */
      if (/\.base$/i.test(rel)) {
        try {
          const text = await io.read(vault?.localPath ?? '', rel);
          setBaseDoc({ path: rel, text });
          onClosePdf();
          setImageView(null);
        } catch (e) {
          toast(`打不开：${e instanceof Error ? e.message : String(e)}`, 'error');
        }
        return;
      }
      if (/\.html?$/i.test(rel)) {
        try {
          const text = await io.read(vault?.localPath ?? '', rel);
          setHtmlDoc({ path: rel, html: text });
          onClosePdf();
          setBaseDoc(null);
          setShowGraph(false);
          setImageView(null);
        } catch (e) {
          toast(`打不开：${e instanceof Error ? e.message : String(e)}`, 'error');
        }
        return;
      }
      if (/\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(rel)) {
        const url = await resolveImage(rel);
        if (url) {
          setImageView({ path: rel, url });
          /*
           * v0.11.22：图片进主区之后，它就得守主区那条"只显示一样东西"的规矩
           * ——和 PDF 一样先把编辑器、表格、HTML、图谱让开。
           * 手机端仍是全屏蒙层（`imageViewEl`），那边不受这几行影响：小屏上
           * 主区本来就是整个屏幕。
           */
          onClosePdf();
          setBaseDoc(null);
          setHtmlDoc(null);
          setShowGraph(false);
          setCurrentPath(null);
          setDoc(null);
          return;
        }
        toast(`打不开这张图片：${rel}`, 'error');
        return;
      }
      await openWithSystemApp(rel);
    },
    [resolveImage, openWithSystemApp, toast, io, vault, onClosePdf]
  );

  /**
   * 图片查看层——**手机端专用**。
   *
   * v0.11.22 起桌面不再用它：图片开在主区里（`ui/ImageViewer`），和 PDF、`.base`、
   * HTML、图谱同一个位置，侧栏和状态栏都还在（用户：「图片查看为什么不直接在
   * 侧边栏右侧的窗口自适应尺寸查看？就像 obsidian 这样」）。
   * 手机上主区就是整个屏幕，蒙层反而正合适，所以那边保留。
   */
  const imageViewEl = imageView ? (
    <div className="img-view" onClick={() => setImageView(null)} role="dialog" aria-label={imageView.path}>
      <img src={imageView.url} alt={imageView.path} />
      <span className="img-view-name">{imageView.path}</span>
    </div>
  ) : null;

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
          // v0.11.24：覆盖之前先把盘上旧内容留一张本机快照（5 分钟一张，失败不挡写盘）
          await fileHistory.snapshotBefore(path);
          await io.write(vault.localPath ?? '', path, text);
          // v0.7.5：即时更新索引。未登录的本地模式下 doSync() 会直接 return、
          // 不触发 refreshFiles，光靠咽喉对账的话离线写作时反链/搜索会滞后一拍。
          noteIndex.touch(path, text);
          // v0.11.30：桌面小部件上的这篇跟着更新（非安卓 no-op）
          launcherRef.current?.notePersisted(path, text);
          // 「自动同步」关掉时，落盘后也不再顺手推——设置里写的是「关掉后只能手动同步」，
          // 只挡住启动/回前台/轮询那三条而放行这一条，说明就成了假话（v0.8.6 的疏漏）。
          if (prefs.autoSync) void doSync();
          // v0.4.0：标题跟随（在写盘之后执行，避免和防抖写盘竞争）
          void maybeRenameToH1(path, text);
        } catch (e) {
          console.error('写盘失败', e);
          toast(`保存失败：${errText(e)}`, 'error');
        } finally {
          saveTimers.current.delete(path);
        }
      }, 800));
    },
    [vault, io, currentPath, splitPath, prefs.autoSync, doSync, maybeRenameToH1, noteIndex, toast, fileHistory]
  );

  /**
   * v0.11.24：把某一版历史内容恢复成当前内容。
   *
   * 就是一次普通写盘：先给"现在这版"强制留快照（恢复错了能再恢复回来），写盘，
   * 编辑器回灌，索引更新，推同步——和用户手动改回去走的是同一条路，
   * 服务端不需要知道"这是一次恢复"。
   */
  const restoreVersion = useCallback(
    async (path: string, content: string) => {
      if (!vault) return;
      const root = vault.localPath ?? '';
      // 编辑器里还没落盘的改动先落下去，快照才是完整的"现在"
      const pending = saveTimers.current.get(path);
      if (pending !== undefined) {
        window.clearTimeout(pending);
        saveTimers.current.delete(path);
        const live = path === currentPathRef.current ? docRef.current : path === splitPathRef.current ? splitDocRef.current : null;
        if (live !== null) await io.write(root, path, live);
      }
      await fileHistory.snapshotBefore(path, true);
      await io.write(root, path, content);
      if (path === currentPathRef.current) setDoc(content);
      if (path === splitPathRef.current) setSplitDoc(content);
      noteIndex.touch(path, content);
      launcherRef.current?.notePersisted(path, content);
      if (prefs.autoSync) void doSync();
    },
    [vault, io, fileHistory, noteIndex, prefs.autoSync, doSync]
  );

  /**
   * v0.11.31：不经过编辑器、程序性地改一篇笔记（桌面待办小部件勾掉一条走这里）。
   *
   * 与 restoreVersion 同一条路：先把编辑器里没落盘的改动落下去，拿"现在这版"给 `mutate`，
   * 它返回 null 就什么都不动（比如那一行已经变了）；否则留快照、写盘、编辑器回灌、索引、
   * 小部件、推同步——和用户手动改是同一个结果，服务端不需要知道是谁改的。
   */
  const rewriteNote = useCallback(
    async (path: string, mutate: (content: string) => string | null): Promise<boolean> => {
      if (!vault) return false;
      const root = vault.localPath ?? '';
      const live = path === currentPathRef.current ? docRef.current : path === splitPathRef.current ? splitDocRef.current : null;
      const pending = saveTimers.current.get(path);
      if (pending !== undefined) {
        window.clearTimeout(pending);
        saveTimers.current.delete(path);
        if (live !== null) await io.write(root, path, live);
      }
      const before = live ?? (await io.read(root, path));
      const after = mutate(before);
      if (after === null || after === before) return false;
      await fileHistory.snapshotBefore(path);
      await io.write(root, path, after);
      if (path === currentPathRef.current) setDoc(after);
      if (path === splitPathRef.current) setSplitDoc(after);
      noteIndex.touch(path, after);
      launcherRef.current?.notePersisted(path, after);
      if (prefs.autoSync) void doSync();
      return true;
    },
    [vault, io, fileHistory, noteIndex, prefs.autoSync, doSync]
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

  /* ---------- v0.11.18：AI 与排版整理 ---------- */
  /*
   * 排版整理复用 AI 那套预览面板，所以给它一个同形状的"动作"描述。
   * 它不走网络、不花钱：这一点在面板的提示里就写着，免得用户以为整理也在调模型。
   */
  const TIDY_SPEC: AiActionSpec = {
    id: 'structure',
    label: '排版整理',
    hint: '纯本地规则，不联网、不花钱：中英文空格 / 标点 / 列表符号 / 标题层级 / 多余空行',
    mode: 'replace',
    system: '',
  };

  /**
   * AI 的三条铁律，写在这儿免得后面越界：
   * ① **只发该发的那点内容**——替换类动作要求先选中文字，绝不默认整篇上传；
   * ② **结果不落盘**，先进面板给 diff，用户点「应用」才写；
   * ③ 替换走编辑器的 dispatch，进得了撤销栈——Ctrl+Z 能把 AI 的改动退回去。
   */
  const [aiState, setAiState] = useState<{
    spec: AiActionSpec | null;
    source: string;
    result: string;
    busy: boolean;
    error: string | null;
    scope: string;
    /** 替换类动作要还原到哪一段；整篇替换时为 null */
    range: { from: number; to: number } | null;
    /** 自定义指令的**用户原话**：存成动作时要原样存下来，不是存拼好的提示词 */
    instruction?: string;
  }>({ spec: null, source: '', result: '', busy: false, error: null, scope: '', range: null });
  const aiAbort = useRef<AbortController | null>(null);
  /**
   * 「今天写了什么」要先打开今日日记，可 openDaily 是后面才由 useTemplates 给的。
   * 用 ref 接一下，比把一大段 AI 逻辑挪到 hook 之后要好读。
   */
  const openDailyRef = useRef<null | (() => void | Promise<void>)>(null);
  const selectionApi = useRef<SelectionApi | null>(null);
  const exposeSelection = useCallback((api: SelectionApi | null) => {
    selectionApi.current = api;
  }, []);

  const runAi = useCallback(
    async (
      spec: AiActionSpec,
      text: string,
      scope: string,
      range: { from: number; to: number } | null,
      instruction?: string
    ) => {
      const cfg = { ...prefs.ai, temperature: spec.id === 'proofread' ? 0 : 0.3 };
      if (!isLlmConfigured(cfg)) {
        toast('还没配置大模型：设置 → AI，填接口地址与模型名', 'error');
        setShowSettings(true);
        return;
      }
      aiAbort.current?.abort();
      const ac = new AbortController();
      aiAbort.current = ac;
      setAiState({ spec, source: text, result: '', busy: true, error: null, scope, range, instruction });
      try {
        const full = await streamChat(
          cfg,
          buildMessages(spec, text),
          (delta) => setAiState((st) => (st.spec === spec ? { ...st, result: st.result + delta } : st)),
          ac.signal
        );
        setAiState((st) => (st.spec === spec ? { ...st, result: cleanReply(full), busy: false } : st));
      } catch (e) {
        if (ac.signal.aborted) return;
        setAiState((st) =>
          st.spec === spec ? { ...st, busy: false, error: e instanceof Error ? e.message : String(e) } : st
        );
      }
    },
    [prefs.ai, toast]
  );

  /** 从编辑器取要处理的文本：替换类必须有选区，产出类没选区就用整篇 */
  const startAi = useCallback(
    (spec: AiActionSpec) => {
      const sel = selectionApi.current?.get() ?? null;
      if (spec.mode === 'replace') {
        if (!sel || !sel.text.trim()) {
          toast(`「${spec.label}」要先选中一段文字——默认不会把整篇笔记发出去`, 'error');
          return;
        }
        void runAi(spec, sel.text, `选中的 ${sel.text.length} 字`, { from: sel.from, to: sel.to });
        return;
      }
      const text = sel?.text.trim() ? sel.text : (doc ?? '');
      if (!text.trim()) {
        toast('这篇还是空的', 'error');
        return;
      }
      void runAi(spec, text, sel?.text.trim() ? `选中的 ${sel.text.length} 字` : '整篇笔记', null);
    },
    [doc, runAi, toast]
  );

  /**
   * **自定义指令**：用户自己说一句要怎么处理。
   *
   * 内置那十二条再多也盖不全人的需求（「改成给客户看的口吻」「把人名换成代号」），
   * 这一条等于无数条。有选区就改这一段，没选区就把结果附到文末——
   * 「没选中还要替换」只能意味着替换整篇，那种事这个软件不做。
   */
  const startCustomAi = useCallback(async () => {
    const sel = selectionApi.current?.get() ?? null;
    const hasSel = !!sel?.text.trim();
    const instruction = await prompt({
      title: '让 AI 做什么',
      description: hasSel
        ? `作用于选中的 ${sel!.text.length} 字，结果先给你看对照，不直接写进笔记`
        : '没有选中文字，所以结果会作为新内容附到文末，不会覆盖原文',
      placeholder: '例如：改写成给客户看的口吻，去掉内部黑话',
      okText: '开始',
      validate: (v) => (v.trim().length < 2 ? '说清楚要怎么处理' : null),
    });
    if (!instruction) return;
    const spec = customSpec(instruction.trim(), hasSel ? 'replace' : 'produce');
    if (hasSel) {
      void runAi(spec, sel!.text, `选中的 ${sel!.text.length} 字`, { from: sel!.from, to: sel!.to }, instruction.trim());
    } else {
      const text = doc ?? '';
      if (!text.trim()) {
        toast('这篇还是空的', 'error');
        return;
      }
      void runAi(spec, text, '整篇笔记', null, instruction.trim());
    }
  }, [doc, prompt, runAi, toast]);

  /** **问这篇笔记**：答案只许来自这一篇，问不到就该说问不到 */
  const askThisNote = useCallback(async () => {
    const sel = selectionApi.current?.get() ?? null;
    const text = sel?.text.trim() ? sel.text : (doc ?? '');
    if (!text.trim()) {
      toast('这篇还是空的', 'error');
      return;
    }
    const q = await prompt({
      title: '问这篇笔记',
      description: sel?.text.trim() ? `只根据选中的 ${sel.text.length} 字回答` : '只根据这篇笔记的内容回答',
      placeholder: '例如：这篇里我最后定的方案是什么？',
      okText: '问',
      validate: (v) => (v.trim().length < 2 ? '问题写清楚一点' : null),
    });
    if (!q) return;
    void runAi(askNoteSpec(q.trim()), text, sel?.text.trim() ? `选中的 ${sel.text.length} 字` : '整篇笔记', null);
  }, [doc, prompt, runAi, toast]);

  /**
   * **问整个笔记库**。
   *
   * 先在**本地**检索出最相关的几段，再把这几段发出去——绝不是"把库传上去让它找"。
   * 界面上如实写清这次送了哪几篇、多少字：用户有权知道自己的资料出去了多少。
   */
  const askVault = useCallback(async () => {
    if (searchDocs.length === 0) {
      toast('库里还没有可检索的笔记', 'error');
      return;
    }
    const q = await prompt({
      title: '问整个笔记库',
      description: `先在本机检索，只把最相关的几段（最多 5 篇）发给模型，答案会标出处`,
      placeholder: '例如：我之前关于定价的结论是什么？',
      okText: '问',
      validate: (v) => (v.trim().length < 2 ? '问题写清楚一点' : null),
    });
    if (!q) return;
    let passages = retrieve(searchDocs, q.trim());
    /*
     * 本机检索是**词法**的：问「降价」找不到写着「打折」的那篇。
     * 真正的解法是语义向量，但那要嵌入模型、要存索引、要随笔记增量更新，
     * 是另一个量级。这里用一次极小的调用换到大部分收益：**本机一个都没找到时**
     * 让模型给一串同义/相关词，再拿去本地检索。
     *
     * 门槛刻意卡在"零命中"而不是"命中少"：已经找到相关笔记时再掺进一堆同义词，
     * 只会把不相关的笔记也拽进材料里——**给错材料比少给材料更坏**，
     * 而且那些笔记本来不该发出去。
     */
    if (passages.length === 0 && isLlmConfigured(prefs.ai)) {
      try {
        const words = await chat(prefs.ai, expandQueryMessages(q.trim()));
        const widened = retrieve(searchDocs, `${q.trim()} ${words.trim()}`);
        if (widened.length > passages.length) passages = widened;
      } catch {
        // 扩写失败不该让提问失败——它只是个加分项
      }
    }
    if (passages.length === 0) {
      toast('本机检索没找到相关的笔记——换个说法，或者用更具体的词', 'error');
      return;
    }
    const names = passages.map((p) => (p.path.split('/').pop() ?? p.path).replace(/\.md$/i, ''));
    void runAi(
      askVaultSpec(q.trim()),
      buildVaultContext(passages),
      `${passages.length} 篇 · 约 ${totalChars(passages)} 字：${names.join('、')}`,
      null
    );
  }, [prefs.ai, prompt, runAi, searchDocs, toast]);

  /**
   * **今天 / 这周写了什么**。
   *
   * 日记写不下去的真实原因是**想不起来**白天动过什么，而这件事机器全知道（mtime）。
   * 所以：先打开今日日记（结果就该落在这儿），再把这段时间改过的笔记截段送过去。
   * 和「问整个笔记库」同一条规矩——只发截出来的那些段，面板上写明送了几篇多少字。
   */
  const startRecap = useCallback(
    async (range: 'day' | 'week') => {
      const byPath = new Map(searchDocs.map((d) => [d.path, d.content]));
      const entries = mdStamps.map((m) => ({
        path: m.path,
        mtime: m.mtime,
        content: byPath.get(m.path) ?? '',
      }));
      const since = range === 'day' ? startOfDay() : startOfWeek();
      const pieces = pickRecent(entries, { since });
      if (pieces.length === 0) {
        toast(range === 'day' ? '今天还没有改动过任何笔记' : '最近七天没有改动过任何笔记', 'ok');
        return;
      }
      // 结果要贴进日记，那就先把日记打开——不然「应用」会插进当前随便哪一篇
      await openDailyRef.current?.();
      const src = buildRecapSource(pieces);
      void runAi(recapSpec(range), src, `${pieces.length} 篇 · 约 ${src.length} 字`, null);
    },
    [mdStamps, runAi, searchDocs, toast]
  );

  /**
   * 右键菜单里那一组 AI 动作。
   *
   * v0.11.18 把能力做出来了，入口却只挂在顶栏「⋯」的二级菜单和命令面板里——
   * 用户装完的第一句话是「为什么我没有看到任何 AI 按钮呢？只有在设置里面有」。
   * 选中一段字之后，人的手就在右键上；这里才是这些动作的家。
   */
  const editorAiActions = useMemo(
    () => [
      ...AI_ACTIONS.map((a) => ({
        id: a.id,
        label: a.label,
        hint: a.hint,
        needsSelection: a.mode === 'replace',
        // 改写类和产出类分两组：前者会覆盖你选中的字，后者只会多给你一段东西
        group: a.mode === 'replace' ? ('edit' as const) : ('make' as const),
      })),
      // 用户自己存下来的动作，和内置的并排——这才是"自定义"长期有用的形态
      ...prefs.ai.actions.map((a) => ({
        id: `saved:${a.id}`,
        label: a.label,
        hint: a.instruction.length > 20 ? `${a.instruction.slice(0, 20)}…` : a.instruction,
        needsSelection: a.mode === 'replace',
        group: 'saved' as const,
      })),
      { id: 'custom', label: '自定义指令…', hint: '你说要怎么处理', needsSelection: false, group: 'ask' as const },
      { id: 'ask-note', label: '问这篇笔记…', hint: '答案只来自这一篇', needsSelection: false, group: 'ask' as const },
      { id: 'ask-vault', label: '问整个笔记库…', hint: '本机先检索，答案标出处', needsSelection: false, group: 'ask' as const },
      { id: 'recap-day', label: '今天写了什么', hint: '按今天改过的笔记写小结', needsSelection: false, group: 'ask' as const },
      { id: 'recap-week', label: '本周写了什么', hint: '最近七天的小结', needsSelection: false, group: 'ask' as const },
    ],
    [prefs.ai.actions]
  );
  const onEditorAi = useCallback(
    (id: string) => {
      // 这几条要先问一句、或者要先取材，都不在 AI_ACTIONS 里
      if (id === 'custom') return void startCustomAi();
      if (id === 'ask-note') return void askThisNote();
      if (id === 'ask-vault') return void askVault();
      if (id === 'recap-day') return void startRecap('day');
      if (id === 'recap-week') return void startRecap('week');
      if (id.startsWith('saved:')) {
        const saved = prefs.ai.actions.find((a) => `saved:${a.id}` === id);
        if (saved) startAi(savedSpec(saved));
        return;
      }
      const spec = AI_ACTIONS.find((a) => a.id === id);
      if (spec) startAi(spec);
    },
    [askThisNote, askVault, prefs.ai.actions, startAi, startCustomAi, startRecap]
  );

  /** 应用：替换类换掉那一段（走撤销栈），产出类追加到文末 */
  const applyAi = useCallback(() => {
    const st = aiState;
    if (!st.spec || !st.result.trim() || !currentPath) return;
    if (st.spec.mode === 'replace' && st.range) {
      const ok = selectionApi.current?.replace(st.range.from, st.range.to, st.result);
      if (!ok) {
        toast('原文已经变了，没有替换。请重新选中再试一次', 'error');
        return;
      }
      toast(`已应用「${st.spec.label}」（Ctrl+Z 可撤销）`, 'ok');
    } else if (st.spec.id === 'tags') {
      /*
       * 标签是**元数据**，该进 frontmatter，不该在正文末尾多一行井号——
       * 那一行会跟着导出、打印、分享一起出去。合并只增不删（见 lib/noteTags）。
       */
      const { content, added } = mergeTags(doc ?? '', parseTagReply(st.result));
      if (added.length === 0) {
        toast('这些标签这篇已经都有了', 'ok');
      } else {
        setDoc(content);
        onEdit(currentPath, content);
        toast(`已写入 frontmatter：${added.map((t) => `#${t}`).join(' ')}`, 'ok');
      }
    } else {
      const next = `${doc ?? ''}\n\n${st.result.trim()}\n`;
      setDoc(next);
      onEdit(currentPath, next);
      toast(`已插入「${st.spec.label}」的结果到文末`, 'ok');
    }
    setAiState((s) => ({ ...s, spec: null }));
  }, [aiState, currentPath, doc, onEdit, toast]);

  /**
   * 排版整理：**纯本地规则**，不花钱、不联网、每次结果一样（见 lib/tidy）。
   * 同样走预览面板——它虽然只动空白和符号，但那也是用户的文件。
   */
  const tidyNote = useCallback(() => {
    if (!currentPath || doc === null) return;
    const r = tidyMarkdown(doc);
    if (!r.changed) {
      toast('排版已经很规范，没有要改的', 'ok');
      return;
    }
    setAiState({
      spec: TIDY_SPEC,
      source: doc,
      result: r.text,
      busy: false,
      error: null,
      scope: describeTidy(r.report) ?? '整篇笔记',
      range: null,
    });
  }, [currentPath, doc, toast]);

  /* 整理的"应用"要覆盖整篇：它不是 AI 动作，单独走一条 */
  const applyTidy = useCallback(() => {
    if (!currentPath || !aiState.result) return;
    setDoc(aiState.result);
    onEdit(currentPath, aiState.result);
    setAiState((s) => ({ ...s, spec: null }));
    toast('排版已整理', 'ok');
  }, [currentPath, aiState.result, onEdit, toast]);

  /**
   * v0.11.18：按内容自动选阅读密度（字号 / 行宽 / 行高）。
   * 纯函数选档，不问模型——同一篇任何时候都是同一个结果。关掉这项就完全不介入。
   */
  useEffect(() => {
    const root = document.documentElement;
    if (!prefs.autoDensity || doc === null) {
      root.style.removeProperty('--auto-density');
      return;
    }
    const d = pickDensity(doc);
    root.style.setProperty('--fs-body', `${d.fontSize}px`);
    root.style.setProperty('--measure', `${d.measure}px`);
    root.style.setProperty('--lh-body', String(d.lineHeight));
    root.style.setProperty('--auto-density', d.tier);
  }, [prefs.autoDensity, doc]);

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
      /*
       * 源文件不在了 = 这次改名**已经被别人做过了**（同一个提交走了两遍）。
       * 这不是失败，不该弹红字——用户 2026-09-09 看到的「已重命名：untitled → 测试」
       * 和「重命名失败：… untitled.md … 系统找不到指定的文件」正是这么来的。
       * 真正的重复提交在 ui/InlineTitle 里堵掉了，这里是第二道闸：
       * 手机端长按菜单、命令面板都能触发改名，谁都可能撞上同一件事。
       */
      if (!(await io.exists(vault.localPath ?? '', path).catch(() => true))) return;
      try {
        let final = target;
        if (await io.exists(vault.localPath ?? '', final)) {
          // 目标已存在：自动序号 -2、-3…
          const stem = base.replace(/\.md$/i, '');
          let i = 2;
          while (await io.exists(vault.localPath ?? '', `${dir}${stem}-${i}.md`).catch(() => false)) i++;
          final = `${dir}${stem}-${i}.md`;
        }
        let content = await io.read(vault.localPath ?? '', path);
        /*
         * 用户**显式**改了标题 → 正文里那个 H1 要跟着走。
         *
         * 不跟的话：`titleSync` 是「H1 → 文件名」的单向同步，下一次编辑就会按旧 H1
         * 把文件名改回去 —— 用户看到的就是「标题改了又自己变回去」（2026-09-08 反馈）。
         * 只在开着 titleSync 时动正文：关掉这个开关的人不希望我们碰他的字。
         */
        if (prefs.titleSync) {
          const nextTitle = titleOfPath(final);
          const h1 = extractH1(content);
          if (h1 && h1 !== nextTitle) content = replaceFirstH1(content, nextTitle);
        }
        await io.write(vault.localPath ?? '', final, content);
        await io.remove(vault.localPath ?? '', path);
        if (currentPath === path) {
          setCurrentPath(final);
          setDoc(content); // 正文可能被上面改过，编辑区要跟上
        }
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
    [vault, io, currentPath, prefs.titleSync, refreshFiles, doSync, toast, remapTabs, remapRecentPaths, remapSplit]
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

  /**
   * v0.11.22：**重命名文件夹**（用户点名：「增加文件夹重命名的功能」）。
   *
   * 侧栏右键文件夹此前有"新建 / 移动到 / 复制路径 / 删除"，唯独没有改名——
   * 想换个名字只能新建一个再把里面的东西一件件拖过去。
   *
   * 语义就是"在同一层里换个名字"的移动：复用 `applyMoveOps`（新路径 upsert +
   * 旧路径 delete），于是正开着的笔记、标签栏、最近打开、分栏都会跟着换路径，
   * 多端同步也自然收敛。路径计算在 `lib/movePath.planRenameDir` 里（纯函数、有单测）
   * ——改名和移动一样是破坏性操作，算错前缀就是把一整个文件夹的笔记搬丢。
   */
  const onRenameFolder = useCallback(
    async (dir: string) => {
      if (!vault || !dir) return;
      const cur = dir.split('/').pop() ?? dir;
      /** 校验与真正执行**必须用同一份判定**，否则弹框放行了、执行却悄悄不做 */
      const planOf = (v: string) => planRenameDir(dir, sanitizeTitle(v, ''), allPaths());
      const name = await prompt({
        title: '重命名文件夹',
        description: `「${dir}」及其中的全部文件都会跟着换路径`,
        initial: cur,
        okText: '重命名',
        validate: (v) => {
          const plan = planOf(v);
          if (plan.ok) return null;
          return plan.reason === 'taken'
            ? '同一层里已经有同名的文件夹了'
            : plan.reason === 'same'
              ? '名字没有变'
              : '请输入文件夹名（不能包含 / \\ : * ? " < > |）';
        },
      });
      if (!name) return;
      const plan = planOf(name);
      // 校验已经拦过一遍，走到这儿还不 ok 只可能是刚刚被别处改了；说清楚，别静默
      if (!plan.ok) {
        toast(`重命名失败：${plan.reason === 'taken' ? '同名文件夹已存在' : '文件夹名不合法'}`, 'error');
        return;
      }
      try {
        await applyMoveOps(plan.ops);
        // 折叠状态是按目录路径存的：不跟着改名走，改完的文件夹会自己弹开，
        // 而那个已经不存在的旧路径会永远赖在 localStorage 里
        setCollapsedDirs((s) => {
          const next = new Set(remapDirKeys(s, dir, plan.dir));
          saveCollapsed(next);
          return next;
        });
        toast(`已重命名文件夹：${cur} → ${plan.dir.split('/').pop()}`, 'ok');
      } catch (e) {
        toast(`重命名文件夹失败：${errText(e)}`, 'error');
        await refreshFiles();
      }
    },
    [vault, prompt, allPaths, applyMoveOps, refreshFiles, toast]
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
          trashRel = nextTrashName(trashRel);
        }
        /*
         * **按二进制搬进回收站**。此前这里是 `io.read`（文本）——删一张图片或 PDF 时
         * `readTextFile` 解不出合法 UTF-8 直接抛，于是"删不掉"；就算侥幸解出来，
         * 写进回收站的也已经是被有损解码过的废文件。笔记本身是 UTF-8 文本，
         * 按字节搬同样无损，没有必要分两条路。
         */
        const bytes = await io.readBinary(vault.localPath ?? '', path);
        await io.writeBinary(vault.localPath ?? '', trashRel, bytes);
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
   * v0.11.15：**删除文件夹**。
   *
   * 侧栏右键点文件夹此前只有"新建 / 移动 / 复制路径"——没有删除（用户点名）。
   * 语义与删一篇笔记一致：整个文件夹里的文件逐个搬进回收站，可原路恢复；
   * 不做物理删除。空文件夹的 `.keep` 占位一并搬走，否则删完那个空壳还在树里。
   */
  const onDeleteFolder = useCallback(
    async (dir: string) => {
      if (!vault || !dir) return;
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      const all = await io.list(vault.localPath ?? '');
      const inside = all.filter((p) => p.startsWith(prefix));
      const ok = await confirm({
        title: '删除文件夹',
        description:
          inside.length > 0
            ? `「${dir}」及其中 ${inside.length} 个文件将移入回收站，可在回收站恢复。`
            : `「${dir}」是空文件夹，将被删除。`,
        okText: '删除',
        danger: true,
      });
      if (!ok) return;
      try {
        for (const path of inside) {
          // .keep 是我们自己放的占位符，没有恢复价值，直接删掉
          if (path.endsWith('/.keep')) {
            await io.remove(vault.localPath ?? '', path);
            continue;
          }
          let trashRel = trashPathFor(path);
          while (await io.exists(vault.localPath ?? '', trashRel).catch(() => false)) {
            trashRel = nextTrashName(trashRel);
          }
          // 与删单篇同样按字节搬：库里有图片和 PDF，走文本通道会把它们弄坏
          const bytes = await io.readBinary(vault.localPath ?? '', path);
          await io.writeBinary(vault.localPath ?? '', trashRel, bytes);
          await io.remove(vault.localPath ?? '', path);
          if (currentPath === path) {
            setCurrentPath(null);
            setDoc(null);
          }
          if (splitPath === path) closeSplit();
        }
        // 标签里可能还开着这个文件夹下的笔记。启动时那次 pruneTabs 每个库只跑
        // 一次，指望不上——这里按"删完还剩哪些"显式清一遍，否则标签栏留着一排
        // 点开是空白的死标签
        pruneTabs(all.filter((p) => !p.startsWith(prefix)));
        await refreshFiles();
        void doSync();
        toast(`已删除文件夹「${dir}」（${inside.length} 个文件已进回收站）`, 'ok');
      } catch (e) {
        toast(`删除文件夹失败：${errText(e)}`, 'error');
      }
    },
    [vault, io, currentPath, splitPath, closeSplit, pruneTabs, refreshFiles, doSync, confirm, toast, errText]
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
  /** 配对码剩余秒数（0 = 已过期） */
  const [pairLeft, setPairLeft] = useState(0);
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
  /** v0.7.1 F8: graph view（整屏那一版，现在是"全屏打开"才用） */
  const [showGraph, setShowGraph] = useState(false);
  /**
   * v0.11.16：**左栏显示哪个面板**。
   *
   * 从 MainView 提上来：命令面板里的「标签」「回收站」也要能切过来，
   * 而那两条命令在这一层。ribbon 上那一排按钮从此只做一件事——切这个值。
   */
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('files');

  /**
   * v0.11.24：**云端已删除**的文件——回收站面板的第二段。
   *
   * 本机回收站只有"这台设备删的"（现在也包括"别的设备删的、这台 pull 到的"，
   * 见 lib/sync 的 moveToTrash）。但在这之前被删的、或者换了台新设备，本机什么都没有；
   * 云端那份墓碑清单才是全端共同的"可恢复"来源。只列本地现在不存在的。
   */
  const [cloudDeleted, setCloudDeleted] = useState<DeletedFile[]>([]);
  const refreshCloudDeleted = useCallback(async () => {
    if (!client || !vault || vault.id <= 0) {
      setCloudDeleted([]);
      return;
    }
    try {
      const { files: gone } = await client.deletedFiles(vault.id);
      const local = new Set(allPaths());
      setCloudDeleted(gone.filter((f) => !local.has(f.path)));
    } catch (e) {
      // 列不到就当没有；不该因为它把回收站面板整个弄红
      console.warn('云端已删除清单读取失败', e);
      setCloudDeleted([]);
    }
  }, [client, vault, allPaths]);
  useEffect(() => {
    if (sidebarTab === 'trash') void refreshCloudDeleted();
  }, [sidebarTab, refreshCloudDeleted, trash.list]);

  /** 从云端把一份已删除的文件拿回来：写回原路径，下一轮 push 就是普通 upsert */
  const restoreCloudDeleted = useCallback(
    async (f: DeletedFile) => {
      if (!client || !vault) return;
      const root = vault.localPath ?? '';
      try {
        if (await io.exists(root, f.path)) {
          toast(`${f.path} 本地已经有一份了，没有覆盖`, 'error');
          return;
        }
        const bytes = new Uint8Array(await client.getBlob(f.blob_hash));
        if (/\.(md|markdown|txt|base|html?|json|css|csv)$/i.test(f.path)) {
          await io.write(root, f.path, new TextDecoder().decode(bytes));
        } else {
          await io.writeBinary(root, f.path, bytes);
        }
        await refreshFiles();
        setCloudDeleted((cur) => cur.filter((x) => x.path !== f.path));
        toast(`已从云端找回：${f.path}`, 'ok');
        void doSync();
      } catch (e) {
        toast(`找回失败：${errText(e)}`, 'error');
      }
    },
    [client, vault, io, refreshFiles, doSync, toast, errText]
  );

  /** 右栏「历史」标签的数据与动作 */
  const historyProps = useMemo(
    () => ({
      path: currentPath,
      current: doc ?? '',
      history: fileHistory,
      onRestore: restoreVersion,
      toast,
    }),
    [currentPath, doc, fileHistory, restoreVersion, toast]
  );
  /** 点标签面板里的标签 → 灌进侧栏搜索框（带序号，连点两次也要重搜） */
  const [sideSearchSeed, setSideSearchSeed] = useState<{ text: string; n: number } | null>(null);

  /**
   * v0.10.5：内置同步服务端。
   *
   * 「Windows + 安卓」是主力组合，而它此前要同步，第一步是自己搭一台服务器。
   * 现在服务端随桌面包一起发，这里负责起停 + **起完自动登录**——
   * 少了自动登录这一步，用户还是要面对账号密码，"点点点"就断在最后一米。
   */
  const onLogout = useCallback(() => {
    // 只清登录态，保留全部本地笔记（含免登录本地库），下次登录可继续迁移
    clearAccount();
    setState((s) => ({ ...s, account: undefined }));
    setShowLogin(false);
    setCurrentPath(null);
    setDoc(null);
    setLastReport(null);
  }, [setLastReport]);

  const [localSrv, setLocalSrv] = useState<LocalServerInfo | null>(null);
  const [localSrvBusy, setLocalSrvBusy] = useState(false);
  const [localSrvOk, setLocalSrvOk] = useState(false);

  useEffect(() => {
    void (async () => {
      const ok = await localServerAvailable();
      setLocalSrvOk(ok);
      if (ok) setLocalSrv(await localServerStatus());
    })();
  }, []);

  const toggleLocalServer = useCallback(
    async (next: boolean) => {
      setLocalSrvBusy(true);
      try {
        if (!next) {
          const info = await stopLocalServer();
          setLocalSrv(info);
          /*
           * 服务停了，登录态却还指着 http://127.0.0.1:8080——自动同步会每 60 秒
           * 往一个已经不存在的服务器上撞一次，屏幕上是一连串"连不上"，
           * 而设置里仍然写着"已登录"。停服务就等于这台设备退出同步。
           */
          if (isLocalServerAccount(stateRef.current.account?.serverUrl)) onLogout();
          toast(info.running ? '本机同步服务仍在运行（可能是在应用之外启动的）' : '已停止本机同步服务', info.running ? 'error' : 'ok');
          return;
        }
        const { info, cred } = await startLocalServer();
        setLocalSrv(info);
        // 起完就登录：凭据是本机生成保存的，用户全程不需要知道它
        if (!stateRef.current.account) {
          await onLogin(info.url, cred.email, cred.password);
        }
        toast('本机同步已开启', 'ok');
      } catch (e) {
        toast(`开启失败：${errText(e)}`, 'error');
        setLocalSrv(await localServerStatus());
      } finally {
        setLocalSrvBusy(false);
      }
    },
    [onLogin, onLogout, toast]
  );

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
      setPairLeft(r.expires_in);
    } catch (e) {
      toast(`生成配对码失败：${errText(e)}`, 'error');
    } finally {
      setPairBusy(false);
    }
  }, [client, toast]);

  /*
   * 配对码只活 60 秒（服务端 pairTTL），可弹层上写的是一句静态的「60 秒内有效」——
   * 过期之后屏幕上那串数字看着照样有效，用户在手机上一遍遍输、一遍遍报错。
   * 这里给它真倒计时，归零就换成「重新生成」。
   */
  useEffect(() => {
    if (!pairInfo || pairLeft <= 0) return;
    const t = window.setInterval(() => setPairLeft((n) => (n > 0 ? n - 1 : 0)), 1000);
    return () => window.clearInterval(t);
  }, [pairInfo, pairLeft]);
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
  /**
   * v0.11.25：**新建笔记库 = 选一个文件夹。**
   *
   * 用户原话：「新建文件库就应该是新建本地文件夹或者选择本地文件夹」「库名就应该是
   * 文件夹名字」「我压根找不到源文件在手机上的哪个位置」。此前新建默认落在 `opfs://`
   * ——应用内部存储，安卓在 /data/data/…/app_webview/ 里，文件管理器根本看不到，
   * 卸载即清；再靠「绑定本地目录」挪出来，两步之间就是 2026-09-11 那次事故的窗口。
   *
   * 现在：桌面走系统文件夹对话框（对话框里能新建文件夹），安卓走 SAF 选目录；
   * 库名 = 文件夹名；选中的文件夹里已经有 .md 就直接当库用（Obsidian 的
   * "Open folder as vault"）。只有浏览器版（没有磁盘）还是问名字、落内部存储。
   */
  /**
   * 选目录这一步在安卓上可能等不到结果（见 lib/saf 的 pendingPick 注释）：
   * 发起前先记下"我要干什么"，结果回来了就清掉；等不到的话下次启动从 SharedPreferences
   * 里把结果领回来接着做。
   */
  const pickFolderFor = useCallback(
    async (action: 'create' | 'bind', vaultIdFor: number | null): Promise<{ uri: string; name?: string } | null> => {
      if (isAndroidUA()) {
        rememberPendingPick({ action, vaultId: vaultIdFor, at: Date.now() });
        try {
          const picked = await pickVaultFolder();
          if (!picked) {
            toast('没有选择文件夹', 'info');
            return null;
          }
          return picked;
        } finally {
          clearPendingPick();
        }
      }
      const { open } = await import('@tauri-apps/plugin-dialog');
      const r = await open({ directory: true, title: action === 'create' ? '选择或新建一个文件夹作为笔记库' : '把笔记库移到哪个文件夹' });
      if (typeof r !== 'string' || !r) return null;
      return { uri: r };
    },
    [toast]
  );

  /*
   * 两段"后半段"都是普通函数（每次渲染拿最新闭包），外面用 ref 转一手再包成稳定的
   * useCallback——它们要被 pendingPick 的启动补偿调用，而那个 effect 只能依赖稳定引用。
   */
  const finishCreateVaultRef = useRef(finishCreateVault);
  finishCreateVaultRef.current = finishCreateVault;
  const applyPickedFolderRef = useRef(applyPickedFolderImpl);
  applyPickedFolderRef.current = applyPickedFolderImpl;
  const applyPickedFolder = useCallback(
    (sel: string, label: string | null) => applyPickedFolderRef.current(sel, label),
    []
  );

  /** 新建库的后半段：文件夹已经选好（或者从 pendingPick 领回来）。sel 为 null = 浏览器版走名字 */
  const createVaultAt = useCallback(
    async (sel: string | null, label: string | undefined, typedName: string | null) => {
      const cur = stateRef.current;
      let name: string;
      if (sel) {
        const taken = Object.values(cur.vaults).find((v) => v.localPath === sel);
        if (taken) {
          toast(`这个文件夹已经是「${vaultDisplayName(taken)}」了`, 'error');
          setVaultId(taken.id);
          return;
        }
        name = vaultDisplayName({ name: '', localPath: sel, localLabel: label }) || folderName(sel);
      } else {
        name = (typedName ?? '').trim();
        if (!name) return;
      }
      const withPlace = (m: VaultMeta): VaultMeta =>
        sel ? { ...m, localPath: sel, localLabel: label, syncedAt: sel } : m;
      await finishCreateVaultRef.current(cur, name, sel, withPlace);
    },
    [toast]
  );

  const createVault = useCallback(async () => {
    let sel: string | null = null;
    let label: string | undefined;
    if (isTauri) {
      let picked: { uri: string; name?: string } | null;
      try {
        picked = await pickFolderFor('create', null);
      } catch (e) {
        toast(`选择文件夹失败：${errText(e)}`, 'error');
        return;
      }
      if (!picked) return;
      sel = picked.uri;
      label = picked.name;
      await createVaultAt(sel, label, null);
      return;
    }
    const typed = await prompt({
      title: '新建笔记库',
      placeholder: '笔记库名称',
      okText: '创建',
      validate: (v) => (v.trim() ? null : '请输入名称'),
    });
    if (!typed) return;
    await createVaultAt(null, undefined, typed);
  }, [pickFolderFor, createVaultAt, prompt, toast]);

  async function finishCreateVault(
    cur: PersistState,
    name: string,
    sel: string | null,
    withPlace: (m: VaultMeta) => VaultMeta
  ) {
    if (!client) {
      const id = nextLocalVaultId(cur.vaults);
      persist({ ...cur, vaults: { ...cur.vaults, [String(id)]: withPlace(newVaultMeta(id, name)) } });
      setVaultId(id);
      setCurrentPath(null);
      setDoc(null);
      toast(sel ? `笔记库「${name}」已建在 ${sel}` : `已创建本地笔记库「${name}」`, 'ok');
      return;
    }
    try {
      const v = await client.createVault(name);
      persist({ ...cur, vaults: { ...cur.vaults, [String(v.id)]: withPlace(newVaultMeta(v.id, v.name)) } });
      setVaultId(v.id);
      setCurrentPath(null);
      setDoc(null);
      toast(sel ? `笔记库「${name}」已建在 ${sel}，会同步到云端` : `已创建笔记库「${name}」`, 'ok');
    } catch (e) {
      toast(`创建失败：${errText(e)}`, 'error');
    }
  }

  /**
   * v0.11.25：删除笔记库。此前只有新建没有删除，测试用的空库一直挂着。
   *
   * 规矩：**用户的文件一个都不碰。** 绑了磁盘文件夹 / SAF 目录的，只从列表里去掉，
   * 文件原地留着；只有应用内部存储（opfs://）那份会被清掉——它不在任何用户看得见的
   * 地方，留着只是占空间。云端库还要在服务端打软删除，否则下次对齐列表又会回来
   * （其它设备下次对齐时也会跟着放手，见 lib/vaultLink）。
   */
  const deleteVault = useCallback(
    async (id: number) => {
      const cur = stateRef.current;
      const target = cur.vaults[String(id)];
      if (!target) return;
      const bound = !!target.localPath && !target.localPath.startsWith('opfs://');
      const cloud = id > 0 && !!client;
      const title = `删除笔记库「${vaultDisplayName(target)}」？`;
      const lines = [
        bound
          ? `文件夹 ${vaultLocationLabel(target)} 里的文件不会被删除，只是不再作为笔记库打开。`
          : '它存在应用内部存储里，删除后这份内容就没有了。',
        cloud ? '云端也会标记删除：其它设备下次同步会自动放手（它们本地的文件同样不动）。' : '',
        '云端保留历史版本，误删可联系管理员恢复。',
      ].filter(Boolean);
      const ok = await confirm({ title, description: lines.join('\n\n'), okText: '删除', danger: true });
      if (!ok) return;
      try {
        if (cloud) await client!.deleteVault(id);
      } catch (e) {
        toast(`云端删除失败，笔记库未改变：${errText(e)}`, 'error');
        return;
      }
      if (!bound) {
        try {
          await removeOpfsVault(id);
        } catch (e) {
          console.warn('清理应用内部存储失败', e);
        }
      }
      const rest = { ...cur.vaults };
      delete rest[String(id)];
      let next: PersistState = { ...cur, vaults: rest };
      // 一个都不剩就补一个本地库，界面不能空壳
      if (Object.keys(rest).length === 0) next = ensureLocalVault(next);
      persist(next);
      if (activeVaultId === id) {
        const pick = Object.values(next.vaults).sort((a, b) => b.id - a.id)[0];
        setVaultId(pick ? pick.id : null);
        setCurrentPath(null);
        setDoc(null);
      }
      toast(`已删除笔记库「${vaultDisplayName(target)}」${bound ? '（文件还在原文件夹里）' : ''}`, 'ok');
    },
    [client, confirm, persist, toast, activeVaultId]
  );

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
    let picked: { uri: string; name?: string } | null;
    try {
      picked = await pickFolderFor('bind', vault.id);
    } catch (e) {
      toast(`选择文件夹失败：${errText(e)}`, 'error');
      return;
    }
    if (!picked) return; // 用户取消
    await applyPickedFolder(picked.uri, picked.name ?? null);
  }, [vault, pickFolderFor, toast, applyPickedFolder]);

  /** 绑定 / 换位置的后半段：文件夹已经选好（或者从 pendingPick 领回来） */
  async function applyPickedFolderImpl(sel: string, label: string | null) {
    const vault = stateRef.current.vaults[String(activeVaultId ?? '')];
    if (!vault) return;
    const from = vault.localPath ?? '';
    if (from === sel) return;
    const wasVirtual = !from || from.startsWith('opfs://');
    const count = allPaths().length;
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
    const newName = vaultDisplayName({ name: vault.name, localPath: sel, localLabel: label ?? undefined });
    patchVault(vault.id, (m) => {
      m.localPath = sel as string;
      m.localLabel = label ?? undefined;
      // 库名跟着文件夹名走（v0.11.25）
      m.name = newName;
      /*
       * 账本换位置（v0.11.25）：这里**不**改 syncedAt——留给同步引擎在下一轮发现
       * "账本是在旧位置对出来的"，按新设备冷启动全量对账（lib/sync relocateIfMoved）。
       * 刚复制过去的文件和云端一模一样，对账只会确认、不会推一条 delete。
       */
    });
    if (client && vault.id > 0 && newName !== vault.name) {
      client.renameVault(vault.id, newName).catch(() => {
        /* 云端名字下次对齐列表时再纠正；不挡本地 */
      });
    }
    await refreshFiles();
    toast(count > 0 ? `已移动 ${count} 个文件到新位置，库名改为「${newName}」` : `已设置笔记库位置：${newName}`, 'ok');
  }

  /**
   * 撤回到应用内部存储。
   *
   * v0.10.2：加一次确认并说清后果——内部存储**卸载即清空**，
   * 这是「安卓更新完笔记没了」这类事故的源头，不该一声不响地切过去。
   * 磁盘上的原文件保留不动，所以这个动作本身不会删任何东西。
   */
  /**
   * v0.11.26：安卓上"选完文件夹没反应"的补偿。
   *
   * 系统目录选择器回来时主 Activity 可能已被回收重建，WebView 重载，等结果的 Promise
   * 随之消失。Kotlin 侧把结果存进了 SharedPreferences（takePendingPick），JS 侧发起前
   * 记了"我要干什么"（rememberPendingPick）。两边都在 → 启动时把没走完的那半段走完。
   */
  const pendingPickDone = useRef(false);
  useEffect(() => {
    if (pendingPickDone.current || !isTauri || !isAndroidUA() || !vault) return;
    pendingPickDone.current = true;
    const intent = readPendingPick();
    if (!intent) return;
    clearPendingPick();
    void (async () => {
      try {
        const got = await takePendingPick();
        if (!got || !got.uri) {
          toast('上次选文件夹没有拿到结果，请再选一次', 'info');
          return;
        }
        // 结果必须是这次意图**之后**产生的：正常走完的那些选择也会留在原生侧，
        // 拿一个旧结果去配一个后来被取消的意图，就把库绑到了用户没选的地方
        if (got.at < intent.at || Date.now() - intent.at > 15 * 60 * 1000) return;
        if (intent.action === 'create') {
          await createVaultAt(got.uri, got.name || undefined, null);
        } else if (intent.vaultId === vault.id) {
          await applyPickedFolder(got.uri, got.name || null);
        }
      } catch (e) {
        toast(`接着处理上次选的文件夹失败：${errText(e)}`, 'error');
      }
    })();
  }, [vault, toast, createVaultAt, applyPickedFolder]);

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
        const abs = `${root.replace(/\/$/, '')}/${rel}`;
        try {
          const how = await openWithSystem(abs);
          if (how === 'obsidian') {
            toast(`「${baseNameOf(abs)}」是 Obsidian 自己的格式，已交给 Obsidian 打开`, 'info');
          } else if (how === 'revealed') {
            toast(`系统里没有能打开「${baseNameOf(abs)}」的程序，已在文件夹中定位`, 'info');
          }
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

  // 「今天写了什么」要用它先把日记打开（声明顺序所限，见上面 openDailyRef 那段）
  useEffect(() => {
    openDailyRef.current = openDailyNote;
  }, [openDailyNote]);

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
      // 附件（PDF / 图片 / .base）比对的是哈希，不是全文
      const assetHashes = new Map<string, string>();
      for (const p of allFiles) {
        if (/\.(md|markdown)$/i.test(p)) continue;
        try {
          assetHashes.set(p, await sha256Hex(await io.readBinary(root, p)));
        } catch {
          // 读不出来的单个附件跳过，不让整次统计失败
        }
      }
      setSyncStatusList(classifyVault(contents, vault, assetHashes));
    } finally {
      setSyncStatusBusy(false);
    }
  }, [vault, io, files, allFiles]);

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
      onOpenGraph: () => {
        setShowGraph(true);
        setImageView(null); // 主区一次只显示一样东西
      },
      onToggleSplit: () => (splitPath ? closeSplit() : void openSplit()),
      onOpenSyncStatus: openSyncStatus,
      onNewFromTemplate: () => void newFromTemplate(),
      onToggleTheme: toggleTheme,
      onOpenSettings: () => setShowSettings(true),
      onCheckUpdate: checkUpdateNow,
      onAddDevice: state.account ? () => void showPairCode() : null,
      onOpenTrash: vault
        ? () => {
            setSidebarTab('trash');
            void trash.reload();
          }
        : null,
      onOpenTags: vault ? () => setSidebarTab('tags') : null,
      onTidy: currentPath ? tidyNote : null,
      onAi: currentPath ? onEditorAi : null,
      onOpenHistory: currentPath ? () => setWantRightTab('history') : null,
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
      currentPath,
      tidyNote,
      onEditorAi,
    ]
  );
  const { paletteMode, closePalette, commands } = useCommands({
    enabled: !!vault,
    splitOpen: !!splitPath,
    theme,
    appVersion,
    actions: commandActions,
  });

  /**
   * **Esc 关最上面那一层**。
   *
   * 设置里的快捷键表一直写着「Esc 关闭当前浮层」，可实际上只有设置、命令面板、
   * 右键菜单和 prompt 弹框吃这个键——图谱、标签、回收站、冲突、配对码、
   * 同步状态、移动到…全都不吃，按了没反应。
   *
   * 与其给七个组件各挂一个 window 监听（那样多层叠着时会一起塌），
   * 不如在这里按「谁在最上面」的顺序只关一层。命令面板和 prompt 弹框自己
   * 处理，这里让开。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 这两个自带 Esc（还要吃输入框里的 Esc），交给它们
      if (paletteMode || dialogEl) return;
      const layers: [boolean, () => void][] = [
        [trash.open, () => trash.setOpen(false)],
        [!!moving, () => setMoving(null)],
        [!!pairInfo, () => setPairInfo(null)],
        [showConflict, () => setShowConflict(false)],
        [showSyncStatus, () => setShowSyncStatus(false)],
        [showTagPanel, () => setShowTagPanel(false)],
        [showGraph, () => setShowGraph(false)],
        [showSettings, () => setShowSettings(false)],
      ];
      const top = layers.find(([open]) => open);
      if (!top) return;
      e.preventDefault();
      top[1]();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    paletteMode,
    dialogEl,
    trash,
    moving,
    pairInfo,
    showConflict,
    showSyncStatus,
    showTagPanel,
    showGraph,
    showSettings,
  ]);

  /*
   * v0.11.16：**「点标签 → 搜标签」不再绕命令面板。**
   * 标签面板现在就在左栏，点一下切到隔壁的搜索面板、把 `#标签` 灌进去即可
   * （见桌面 MainView 的 onPickTag）。此前那段是"打开命令面板 → 用原生 setter
   * 往非受控输入框里塞值 → 派发 input 事件"，纯粹是因为标签在一张弹窗里、
   * 而搜索在另一个地方。手机端仍走抽屉里的搜索（mobileSearchSeed）。
   */

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
            lastError: lastReport?.errors?.[0] ?? null,
            onLogout,
            localServer: localSrvOk
              ? {
                  running: !!localSrv?.running,
                  busy: localSrvBusy,
                  lanUrl: localSrv?.lanUrl ?? null,
                  onToggle: (v) => void toggleLocalServer(v),
                }
              : null,
          }}
          storage={{
            // opfs:// 是虚拟标记，对用户来说就是「应用内部存储」，不该把它当路径显示
            // content:// 那一长串给人看等于没说，有显示名就用显示名
            // v0.11.25：SAF 的 content:// 换算成 Documents/IvyeaNote 这种人能读的路径
            path: vault?.localPath && !vault.localPath.startsWith('opfs://') ? vaultLocationLabel(vault) : null,
            fileCount: allPaths().length,
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

  /*
   * 配对码与冲突两个弹层此前**只写在桌面主分支里**。手机上「设置 → 同步 →
   * 生成配对码」点下去，state 置了、屏幕上什么都不出现——而"用手机连电脑"
   * 恰恰是这两个弹层唯一的用武之地。抽成变量，两端一起挂。
   */
  const pairEl = pairInfo ? (
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
        <div className={`pair-code ${pairLeft === 0 ? 'expired' : ''}`}>{pairInfo.code}</div>
        <p className="dlg-desc">
          {pairLeft > 0 ? `${pairLeft} 秒后过期，仅可使用一次` : '这个码已经过期了，点「重新生成」再来一次'}
        </p>
        {localSrv?.running && localSrv.lanUrl && (
          <p className="dlg-desc">
            新设备若问服务器地址，填 <b>{localSrv.lanUrl}</b>（同一个 Wi-Fi 下也可以让它自己「找找附近的电脑」）。
          </p>
        )}
        <div className="dlg-actions">
          <button
            className="btn ghost"
            disabled={pairLeft === 0}
            onClick={() => {
              void navigator.clipboard?.writeText(pairInfo.code);
              toast('配对码已复制', 'ok');
            }}
          >
            复制配对码
          </button>
          <button className="btn" disabled={pairBusy} onClick={() => void showPairCode()}>
            {pairBusy ? '生成中…' : '重新生成'}
          </button>
          <button className="btn primary" onClick={() => setPairInfo(null)}>
            关闭
          </button>
        </div>
      </div>
    </div>
  ) : null;

  /**
   * v0.11.25 删除熔断的两条出路。
   *
   * 「从云端拉回来」不用走网络：`.md` 的上次同步内容就在账本 `bases` 里，附件按
   * `assets` 里的哈希取 blob。写回本地之后账本没变，下一轮同步就是"本地 = 上次同步"，
   * 什么都不用推。「确实是我删的」走 syncAllowingDeletes，只放行这一轮。
   */
  const [guardBusy, setGuardBusy] = useState(false);
  const restoreMissing = useCallback(async () => {
    const md = lastReport?.massDelete;
    if (!vault || !md) return;
    const root = vault.localPath ?? '';
    setGuardBusy(true);
    let ok = 0;
    const failed: string[] = [];
    try {
      for (const path of md.paths) {
        try {
          if (await io.exists(root, path)) {
            ok++;
            continue;
          }
          const base = vault.bases[path];
          const hash = vault.assets?.[path];
          if (base !== undefined) await io.write(root, path, base);
          else if (hash && client) await io.writeBinary(root, path, new Uint8Array(await client.getBlob(hash)));
          else {
            failed.push(path);
            continue;
          }
          ok++;
        } catch {
          failed.push(path);
        }
      }
      await refreshFiles();
      if (failed.length === 0) toast(`已拉回 ${ok} 篇`, 'ok');
      else toast(`拉回 ${ok} 篇，${failed.length} 篇没成功：${failed.slice(0, 3).join('、')}`, 'error');
      await doSync();
      await refreshSyncStatus();
    } finally {
      setGuardBusy(false);
    }
  }, [vault, io, client, lastReport, refreshFiles, doSync, refreshSyncStatus, toast]);
  const confirmDeletes = useCallback(async () => {
    const md = lastReport?.massDelete;
    if (!md) return;
    const ok = await confirm({
      title: `把 ${md.missing} 篇的删除推到云端？`,
      description: '所有设备都会跟着删（它们会先进各自的回收站，云端也留着历史版本，但请确认这确实是你的意思）。',
      okText: '推上去',
      danger: true,
    });
    if (!ok) return;
    setGuardBusy(true);
    try {
      await syncAllowingDeletes();
      await refreshSyncStatus();
    } finally {
      setGuardBusy(false);
    }
  }, [lastReport, confirm, syncAllowingDeletes, refreshSyncStatus]);

  /*
   * v0.11.25 换了位置：引擎把账本清零、按新位置全量对账。要说一声，否则人看到的只是
   * "同步了一下，多了一堆文件"。
   */
  const relocatedSeen = useRef<string | null>(null);
  useEffect(() => {
    const r = lastReport?.relocated;
    if (!r) return;
    const key = `${r.from}→${r.to}`;
    if (relocatedSeen.current === key) return;
    relocatedSeen.current = key;
    toast(`库位置变了，已按新位置重新对账：拉取 ${lastReport?.pulled ?? 0} 篇、推送 ${lastReport?.pushed ?? 0} 篇；一篇都不会删`, 'ok');
  }, [lastReport, toast]);

  const syncStatusEl = showSyncStatus ? (
    <SyncStatusPanel
      loading={syncStatusBusy}
      list={syncStatusList}
      summary={summarize(syncStatusList)}
      errors={lastReport?.errors ?? []}
      syncing={syncing}
      massDelete={lastReport?.massDelete}
      onRestoreMissing={() => void restoreMissing()}
      onConfirmDeletes={() => void confirmDeletes()}
      busy={guardBusy}
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
  ) : null;

  const conflictEl = showConflict && conflictFiles.length > 0 ? (
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
  ) : null;

  /*
   * 顶栏（v0.11.4）。**必须在每一个桌面分支里都挂**——窗口按钮长在它右端，
   * 漏挂哪一支，那一屏就关不掉窗口。抽成变量而不是复制四遍，正是这个仓库
   * 「弹层挂错树」那条老毛病的解法。移动端不挂：MobileView 自带顶栏。
   */
  /**
   * v0.11.14：顶栏「侧栏正上方那一格」里的四颗按钮。
   *
   * 它们是从侧栏那行 `.side-actions` **搬**上来的，不是新增的第二份入口——
   * 标签页要和它底下那一页左边界对齐，侧栏上方那块位置就空了出来，用户点名
   * 用常用按钮填上，并且「侧边栏收起的时候连带这些功能按钮一起收起」。
   */
  const quickActions: QuickAction[] = useMemo(
    () => [
      { id: 'new-note', icon: 'file-plus', title: '新建笔记', run: () => void onCreateNote('') },
      {
        id: 'new-folder',
        icon: 'folder-plus',
        title: '新建文件夹',
        run: () => void onCreateFolder(''),
      },
      {
        id: 'sort',
        icon: 'sort',
        title: sortMode === 'name' ? '排序：按名称' : '排序：按修改时间',
        items: [
          { id: 'name', label: '按名称', checked: sortMode === 'name', run: () => setSortMode('name') },
          {
            id: 'mtime',
            label: '按修改时间',
            checked: sortMode === 'mtime',
            run: () => setSortMode('mtime'),
          },
        ],
      },
      {
        id: 'collapse',
        icon: 'collapse',
        title: '全部折叠',
        run: () =>
          setCollapsedDirs((cur) => {
            // 已折叠的跳过是多余的：这里是"全部折叠"，直接并进去就行（toggle 才需要跳过）
            const next = new Set(cur);
            for (const d of allDirs) next.add(d);
            saveCollapsed(next);
            return next;
          }),
      },
    ],
    [onCreateNote, onCreateFolder, sortMode, setSortMode, allDirs]
  );

  const aiPanelEl = aiState.spec ? (
    <AiPanel
      spec={aiState.spec}
      source={aiState.source}
      result={aiState.result}
      busy={aiState.busy}
      error={aiState.error}
      scope={aiState.scope}
      onApply={aiState.spec === TIDY_SPEC ? applyTidy : applyAi}
      onRetry={() => {
        if (aiState.spec === TIDY_SPEC) tidyNote();
        else if (aiState.spec) void runAi(aiState.spec, aiState.source, aiState.scope, aiState.range);
      }}
      onCopy={(text) => {
        void navigator.clipboard?.writeText(text);
        toast('结果已复制', 'ok');
      }}
      // 答案里的 [[出处]] 要能一路点回原文，否则出处只是装饰
      onOpenNote={(target) => onOpenLinkPath(target)}
      onSaveAction={
        aiState.spec?.id === 'custom'
          ? () => {
              void (async () => {
                const label = await prompt({
                  title: '存为动作',
                  description: '存下来之后，它会和内置动作并排出现在 AI 菜单里',
                  placeholder: '给它起个短名字，比如「客户口吻」',
                  initial: aiState.spec?.hint.replace(/…$/, '').slice(0, 12) ?? '',
                  okText: '存',
                  validate: (v) => (v.trim() ? null : '起个名字'),
                });
                if (!label || !aiState.spec) return;
                // 存的是**用户原话**，不是拼好的提示词——所见即所得，以后也改得动
                const instruction = aiState.instruction ?? '';
                if (!instruction) return;
                updatePrefs({
                  ...prefs,
                  ai: {
                    ...prefs.ai,
                    actions: [
                      ...prefs.ai.actions,
                      {
                        id: `a${Date.now().toString(36)}`,
                        label: label.trim(),
                        instruction,
                        mode: aiState.spec.mode,
                      },
                    ],
                  },
                });
                toast(`已存为动作「${label.trim()}」`, 'ok');
              })();
            }
          : undefined
      }
      onClose={() => {
        aiAbort.current?.abort();
        setAiState((st) => ({ ...st, spec: null, busy: false }));
      }}
    />
  ) : null;

  const topBarEl = (
    <TopBar
      quick={quickActions}
      tabs={openTabs}
      /* 高亮哪一个标签由 useTabs 说了算：空白标签页没有路径，用 currentPath 认不出它 */
      activeTab={activeTab}
      onSelectTab={(p) => {
        // 空白标签页没有文件可读：只是把主区清空（显示"新标签页"那一屏）
        if (p === NEW_TAB) {
          setCurrentPath(null);
          setDoc(null);
          openBlankTab();
          return;
        }
        void openFileInTab(p);
      }}
      onCloseTab={(p) => {
        const next = closeTab(p);
        if (p === currentPath || (p === NEW_TAB && currentPath === null)) {
          if (next && next !== NEW_TAB) void openFileInTab(next);
          else {
            setCurrentPath(null);
            setDoc(null);
          }
        }
      }}
      /*
       * v0.11.16：`+` 是**新标签页**，不是新建文件（用户点名：「obsidian 的
       * 只有点顶部标签旁边的 + 号才会新增标签页，但是我这个 + 号是新建文件」）。
       * 新建笔记在左上角那一格里，另有其人。
       */
      onNewTab={openBlankTab}
      currentPath={pdfPath ?? currentPath}
      mode={pdfView || !currentPath ? null : viewMode}
      onToggleMode={() => setViewMode((m) => (m === 'edit' ? 'read' : 'edit'))}
      sidebarOpen={sidebarOpen}
      onToggleSidebar={toggleSidebar}
      /*
       * 「⋯」里只放**当前这篇笔记**的动作，而且刻意不重复界面上已有的按钮
       * （阅读/编辑在左边那颗、分栏在状态栏）——同一个功能出现两次，用户第一句
       * 话就是「按钮还有重复的」。
       */
      noteMenu={
        currentPath && !pdfView
          ? [
              { id: 'export-pdf', label: '导出为 PDF…', icon: 'file', run: () => void exportPdf() },
              { id: 'tidy', label: '整理排版（本地规则）', icon: 'text-format', run: tidyNote },
              {
                id: 'ai',
                label: 'AI 助手',
                icon: 'sparkle',
                /*
                 * 和编辑区右键、状态栏那颗按钮**共用同一份构造**（lib/editorMenu 的
                 * aiSubmenu）——三处各写一遍，迟早会长成三张不一样的单子。
                 */
                submenu: aiSubmenu(editorAiActions, true, onEditorAi),
              },
              { type: 'sep', id: 's-1' },
              { id: 'rename', label: '重命名…', icon: 'edit', run: () => void requestRename(currentPath) },
              { id: 'move', label: '移动到…', icon: 'move', run: () => setMoving({ path: currentPath, isDir: false }) },
              { id: 'copy', label: '复制路径', icon: 'copy', run: () => void copyPath(currentPath) },
              ...(isTauri && vault?.localPath && !vault.localPath.startsWith('opfs://')
                ? ([
                    {
                      id: 'reveal',
                      label: '在文件夹中显示',
                      icon: 'folder',
                      run: () => void revealCurrent(currentPath),
                    },
                  ] as MenuItem[])
                : []),
              { type: 'sep', id: 's-2' },
              { id: 'del', label: '删除', icon: 'trash', danger: true, run: () => void onDeleteFile(currentPath) },
            ]
          : []
      }
    />
  );

  /** 切库：主区上一个库的东西（笔记 / PDF / 表格 / HTML / 图片）全部让开 */
  const switchVault = useCallback(
    (id: number) => {
      setVaultId(id);
      setCurrentPath(null);
      setDoc(null);
      onClosePdf();
      setBaseDoc(null);
      setHtmlDoc(null);
      setImageView(null);
      setShowGraph(false);
    },
    [onClosePdf]
  );

  /*
   * v0.11.30：安卓桌面入口——长按图标的快捷方式、桌面小部件、从它们进来时该做的事。
   * 放在这里是因为它要用到 openDailyNote / onCreateNote / switchVault；非安卓平台整个 hook
   * 等于不存在（launcherAvailable() 为 false，所有效果与方法都是 no-op）。
   */
  const launcher = useLauncher({
    vault,
    // 云端库（正数 id）没登录时选了也会被 activeVaultId 回落成本地库，那就别切
    canSwitchTo: (id) => !!state.vaults[String(id)] && (id < 0 || !!state.account),
    knowsVault: (id) => !!state.vaults[String(id)],
    switchVault,
    io,
    files,
    filesLoaded,
    mdStamps,
    metaOf,
    recent,
    currentPath,
    doc,
    openInTab: (p) => void openFileInTab(p),
    createNote: () => onCreateNote(),
    openDaily: () => openDailyNote(),
    toast,
    docs: searchDocs,
    indexReady: noteIndex.ready,
    toggleTask: (path, line, raw) => rewriteNote(path, (c) => toggleTaskLine(c, line, raw)),
  });
  launcherRef.current = launcher;

  // ---------- 渲染 ----------

  if (!state.account && showWelcome) {
    return (
      <>
        {topBarEl}
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
          onDismiss={() => setShowWelcome(false)}
          /*
           * 收欢迎页必须和开登录页一起发生：这个分支排在登录分支**前面**，
           * 只 setShowLogin(true) 的话欢迎页原样留在屏幕上，点了像没反应
           * （从 v0.4.0 起就这样）。
           */
          onOpenLogin={() => {
            setShowWelcome(false);
            setShowLogin(true);
          }}
        />
        {dialogEl}
        {toastEl}
        </div>
      </>
    );
  }

  // 登录页只在用户主动唤起且尚未登录时显示；平时无账号也直达主界面（本地模式）
  // 注意：此处 early return 之前所有 hooks 均已调用完毕（v0.3.3 修复 Rules of Hooks 违例）
  // 登录态过期时同样要能唤起登录页——账号还在 state 里，但它已经不好使了
  if ((!state.account || sessionExpired) && showLogin) {
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
  const vaultList = Object.values(state.vaults)
    .filter((v) => state.account || v.id < 0)
    .map((v) => ({ id: v.id, name: vaultDisplayName(v), location: vaultLocationLabel(v) }));

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
          onRenameFolder={(d) => void onRenameFolder(d)}
          pdfs={pdfs}
          allFiles={allFiles}
          onOpenAttachment={(p) => void onOpenAttachment(p)}
          currentPath={currentPath}
          doc={doc}
          syncing={syncing}
          lastReport={lastReport}
          vaults={vaultList}
          activeVaultId={activeVaultId}
          onSwitchVault={switchVault}
          onDeleteVault={(id) => void deleteVault(id)}
          onSelect={(p) => void openFile(p)}
          onEdit={onEdit}
          exposeSelection={exposeSelection}
          aiActions={editorAiActions}
          onAi={onEditorAi}
          onTidy={tidyNote}
          aiPanel={aiPanelEl}
          onCreateNote={() => void onCreateNote('')}
          onDeleteFile={(p) => void onDeleteFile(p)}
          onRenameFile={(p, name) => void onRenameFile(p, name)}
          backlinks={wikiLinks.back}
          onCheckUpdate={checkUpdateNow}
          onSync={() => void doSync()}
          onOpenSyncStatus={openSyncStatus}
          conflictCount={conflictFiles.length}
          onOpenConflicts={() => setShowConflict(true)}
          onCreateVault={createVault}
          theme={theme}
          onToggleTheme={toggleTheme}
          onLogout={onLogout}
          hasAccount={!!state.account}
          onOpenLogin={() => setShowLogin(true)}
          sessionExpired={sessionExpired}
          syncDisabled={!state.account}
          sortMode={sortMode}
          onSortChange={setSortMode}
          onOpenPdf={(p) => {
            setBaseDoc(null); // 主区三选一：打开 PDF 同样要把 .base 表格收起来
            setImageView(null);
            void onOpenPdf(p);
          }}
          baseDoc={baseDoc}
          baseNotes={baseFiles}
          onCloseBase={() => setBaseDoc(null)}
          onOpenBaseExternal={(p: string) => void openWithSystemApp(p)}
          htmlDoc={htmlDoc}
          onCloseHtml={() => setHtmlDoc(null)}
          onOpenHtmlExternal={(p) => void openWithSystemApp(p)}
          resolveAsset={resolveImage}
          readVaultText={(rel) => io.read(vault?.localPath ?? '', rel)}
          writeVaultText={writeVaultText}
          htmlScriptsAllowed={htmlScriptsAllowed}
          onHtmlScriptsToggle={onHtmlScriptsToggle}
          pdfView={pdfView}
          pdfPath={pdfPath}
          onClosePdf={onClosePdf}
          onOpenPdfExternal={(p) => void openWithSystemApp(p)}
          onInsertImage={onInsertImage}
          resolveImage={resolveImage}
          onOpenPath={onOpenLinkPath}
          onOpenSettings={() => setShowSettings(true)}
          onOpenDaily={() => void openDailyNote()}
          onPinToHome={launcher.enabled ? (p) => void launcher.pinToHome(p) : undefined}
          trashList={trash.list}
          onOpenTrash={() => {
            void trash.reload();
            void refreshCloudDeleted();
          }}
          onTrashRestore={(p) => void trash.restore(p)}
          onTrashPurge={(p) => void trash.purge(p)}
          cloudDeleted={cloudDeleted}
          onCloudRestore={(f) => void restoreCloudDeleted(f)}
          historyProps={historyProps}
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
        {/*
          v0.11.14：**图片查看层在手机上没挂过。**

          `onOpenAttachment` 点图片时会 `resolveImage` 出一个 blob URL 再
          `setImageView`——然后什么都不会发生，因为 `imageViewEl` 只写在下面的
          桌面分支里（用户：「手机端无法直接打开图片、显示图片」）。
          它上面那行注释早就写着"桌面和移动是两棵树，只挂一边就是点了没反应"，
          而它自己正是只挂了一边。
        */}
        {imageViewEl}
        {/* 这三个弹层此前只挂在桌面分支上：手机点「生成配对码」什么都不出现，
            冲突和同步状态在手机上则完全没有出口 */}
        {pairEl}
        {conflictEl}
        {syncStatusEl}
        {dialogEl}
        {toastEl}
      </div>
    );
  }

  if (!vault) {
    return (
      <>
        {topBarEl}
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
          sessionExpired={sessionExpired}
          sidebarOpen={sidebarOpen}
          syncDisabled={!state.account}
          sortMode={sortMode}
          onSortChange={setSortMode}
          onOpenPdf={() => undefined}
          pdfView={null}
          onClosePdf={onClosePdf}
          onCreateVault={createVault}
          collapsedDirs={collapsedDirs}
          onToggleDir={toggleDir}
          onCreateFolder={(parent) => void onCreateFolder(parent ?? '')}
          /* 这一支此前连设置都进不去：一个既不能建笔记、也改不了任何东西的空壳。
             真走到这里（账号下一个库都没有）至少得留着设置和新建库两条出路 */
          onOpenSettings={() => setShowSettings(true)}
          onCreateNote={() => void createVault()}
        />
        {settingsEl}
        {dialogEl}
        {toastEl}
        </div>
      </>
    );
  }

  return (
    <>
      {topBarEl}
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
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        livePreviewOn={prefs.livePreview}
        onOpenSyncStatus={openSyncStatus}
        onOpenAt={(p, line) => {
          void openFileInTab(p);
          setJumpTo((cur) => ({ path: p, line, n: (cur?.n ?? 0) + 1 }));
        }}
        onCloseSplit={closeSplit}
        pdfs={pdfs}
        allFiles={allFiles}
        onOpenAttachment={(p) => void onOpenAttachment(p)}
        currentPath={currentPath}
        doc={doc}
        syncing={syncing}
        lastReport={lastReport}
        onSelect={(p, newTab) => void openFileInTab(p, { newTab })}
        onEdit={onEdit}
        onCreateNote={() => void onCreateNote('')}
        onNewFolderNote={(folder) => void onCreateNote(folder)}
        onDeleteFile={(p) => void onDeleteFile(p)}
        onDeleteFolder={(d) => void onDeleteFolder(d)}
        onRenameFolder={(d) => void onRenameFolder(d)}
        onMovePath={(src, dest, isDir) => void onMovePath(src, dest, isDir)}
        onRequestRename={(p) => void requestRename(p)}
        onCopyPath={(p) => void copyPath(p)}
        onSyncNow={() => void doSync()}
        onUpload={() => void doUpload()}
        onDownload={() => void doDownload()}
        onImportObsidian={() => void onImportObsidian()}
        theme={theme}
        onToggleTheme={toggleTheme}
        onBindFolder={() => void onBindFolder()}
        onUnbindFolder={onUnbindFolder}
        onLogout={onLogout}
        hasAccount={!!state.account}
        onOpenLogin={() => setShowLogin(true)}
        sessionExpired={sessionExpired}
        sidebarOpen={sidebarOpen}
        syncDisabled={!state.account}
        sortMode={sortMode}
        onSortChange={setSortMode}
        onOpenPdf={(p) => {
            setBaseDoc(null); // 主区三选一：打开 PDF 同样要把 .base 表格收起来
            setImageView(null); // 图片也一样（v0.11.22 起它也占着主区）
            void onOpenPdf(p);
          }}
        imageView={imageView}
        onCloseImage={() => setImageView(null)}
        onOpenImageExternal={(p) => void openWithSystemApp(p)}
        baseDoc={baseDoc}
        baseNotes={baseFiles}
        onCloseBase={() => setBaseDoc(null)}
        onOpenBaseExternal={(p: string) => void openWithSystemApp(p)}
        htmlDoc={htmlDoc}
        onCloseHtml={() => setHtmlDoc(null)}
        onOpenHtmlExternal={(p) => void openWithSystemApp(p)}
        resolveAsset={resolveImage}
        readVaultText={(rel) => io.read(vault?.localPath ?? '', rel)}
        writeVaultText={writeVaultText}
        htmlScriptsAllowed={htmlScriptsAllowed}
        onHtmlScriptsToggle={onHtmlScriptsToggle}
        pdfView={pdfView}
        pdfPath={pdfPath}
        onOpenPdfExternal={(p) => void openWithSystemApp(p)}
        onClosePdf={onClosePdf}
        onInsertImage={onInsertImage}
        resolveImage={resolveImage}
        importProgress={importProgress}
        trashCount={trash.list.length}
        /*
         * v0.11.16：回收站与标签都变成左栏的面板（此前是两张对话框，
         * 和 ribbon 上"文件/搜索"那两颗按钮行为不一致——用户说"很乱"的根子）。
         */
        sidebarTab={sidebarTab}
        onSidebarTab={(t) => {
          setSidebarTab(t);
          if (t === 'trash') void trash.reload(); // 切过去就刷新一次，别看陈的
        }}
        trashList={trash.list}
        onTrashRestore={(p) => void trash.restore(p)}
        onTrashPurge={(p) => void trash.purge(p)}
        onTrashPurgeAll={() => void trash.purgeAll()}
        cloudDeleted={cloudDeleted}
        onCloudRestore={(f) => void restoreCloudDeleted(f)}
        historyProps={historyProps}
        wantRightTab={wantRightTab}
        onWantRightTabConsumed={() => setWantRightTab(null)}
        onPickTag={(tag) => {
          setSidebarTab('search');
          setSideSearchSeed((cur) => ({ text: `#${tag}`, n: (cur?.n ?? 0) + 1 }));
        }}
        searchSeed={sideSearchSeed}
        onOpenDaily={() => void openDailyNote()}
        exposeSelection={exposeSelection}
        aiActions={editorAiActions}
        onAi={onEditorAi}
        onTidy={tidyNote}
        aiPanel={aiPanelEl}
        collapsedDirs={collapsedDirs}
        onToggleDir={toggleDir}
        onCreateFolder={(parent) => void onCreateFolder(parent ?? '')}
        conflictCount={conflictFiles.length}
        onOpenSettings={() => setShowSettings(true)}
        searchDocs={searchDocs}
        onPasteImage={onPasteImage}
        /* 图谱开在主区（和 PDF/.base 同一块地方）；ribbon 那颗按钮是开关 */
        graphOpen={showGraph}
        onOpenGraph={() => {
          setShowGraph((v) => !v);
          setImageView(null);
        }}
        onCloseGraph={() => setShowGraph(false)}
        onOpenWiki={(t) => void onOpenWiki(t)}
        onOpenPath={onOpenLinkPath}
        wikiOut={wikiLinks.out}
        wikiBack={wikiLinks.back}
        onOpenWikiPath={(p) => void openFileInTab(p)}
        onOpenConflicts={() => setShowConflict(true)}
        onAddDevice={() => void showPairCode()}
        addDeviceBusy={pairBusy}
        onCreateVault={createVault}
        vaults={vaultList}
        activeVaultId={activeVaultId}
        onSwitchVault={switchVault}
        onDeleteVault={(id) => void deleteVault(id)}
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
      {/* 图谱不再是盖住全屏的一层：它开在主区里（见 ui/MainView 的 graphOpen） */}
      {/* 标签同样搬进了左栏面板；手机端那张 TagPanel 弹层保留（抽屉里没有 ribbon） */}
      {pairEl}
      {conflictEl}
      {settingsEl}
      {/*
        v0.11.16：回收站那张对话框删掉了——它现在是左栏的一个面板（ui/SidePanes）。
        同一个功能留两个入口，迟早变成"两处都要改、只改了一处"。
      */}
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
      {syncStatusEl}
      {/* v0.11.22：桌面的图片不再是蒙层，它开在主区（见上面 MainView 的 imageView）。
          `imageViewEl` 只剩手机那棵树在用。 */}
      {dialogEl}
      {toastEl}
      </div>
    </>
  );
}

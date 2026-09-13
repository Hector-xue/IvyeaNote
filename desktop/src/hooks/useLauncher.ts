/**
 * 安卓桌面入口（v0.11.30）：长按图标快捷方式 + 桌面小部件，在 App 这一侧的全部逻辑。
 *
 * 做四件事，全部只在安卓 Tauri 壳里生效（`launcherAvailable()`），其它平台这个 hook
 * 等于不存在：
 *
 * 1. **领动作并执行**：启动时、以及原生推来 `launch` 事件时，去领「从桌面进来要做什么」
 *    （新建 / 今日日记 / 打开某篇）。要等库和文件列表都就绪才做——「新建」靠文件列表
 *    算不重名的文件名，列表没到就可能覆盖已有的 untitled.md。要打开的那篇在别的库里
 *    就先切库，等新库的列表到了再开。
 * 2. **发布快捷方式**：新建、今日日记 + 最近打开的两篇，最近列表一变就重发（防抖）。
 * 3. **推笔记快照**给小部件：打开一篇、保存一篇时推"最近"快照；被钉在桌面上的那几篇，
 *    只要文件指纹（mtime/size）变了——同步拉下来的、别的应用改的——就重读再推。
 * 4. **添加到桌面**：把当前这篇钉成一张小部件（走系统一键添加；不支持的启动器有两条退路）。
 * 5. **最近笔记列表**（v0.11.31）：和快捷方式一起、最近列表一变就推。
 * 6. **待办**（v0.11.31）：从全文索引里捞出所有未完成的 `- [ ]` 推给小部件；桌面上勾掉一条时
 *    原生发 `todo` 事件过来，这里走 App 的写盘路径改那一行（和手动勾选同一段代码）；
 *    App 没在跑时勾掉的会排在原生的队列里，起来后领走补做。
 *
 * 原生侧不读笔记文件，所以"卡片上显示什么"完全由这里决定：见 lib/widgetText、lib/todoTasks。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileIO, FileMeta } from '../lib/sync';
import type { FileStamp } from '../lib/noteIndex';
import type { VaultMeta } from '../lib/store';
import { titleOfPath } from '../lib/wikilink';
import { widgetPreview } from '../lib/widgetText';
import { collectTasks } from '../lib/todoTasks';
import {
  launcherAvailable,
  takeLaunchAction,
  onLaunchAction,
  setShortcuts,
  setNoteSnapshot,
  boundNotes,
  rebindNotes,
  pinNoteWidget,
  setRecentNotes,
  setTodoSnapshot,
  takePendingToggles,
  setTodoLive,
  onTodoToggle,
  buildShortcuts,
  buildRecentNotes,
  isActionFresh,
  type LaunchAction,
  type TodoItem,
} from '../lib/launcher';

export interface LauncherDeps {
  vault: VaultMeta | null;
  /** 要切过去的那个库现在能不能用（存在，且云端库要已登录） */
  canSwitchTo(id: number): boolean;
  switchVault(id: number): void;
  /** 某个库 id 是否还认识（判断小部件绑定的旧库 id 是不是已经不在了） */
  knowsVault(id: number): boolean;
  io: FileIO;
  files: string[];
  /** 当前库的列表至少扫成功过一次（useVaultFiles.loaded） */
  filesLoaded: boolean;
  mdStamps: FileStamp[];
  metaOf(path: string): FileMeta | undefined;
  recent: string[];
  currentPath: string | null;
  doc: string | null;
  openInTab(path: string): void;
  createNote(): void | Promise<void>;
  openDaily(): void | Promise<void>;
  toast(msg: string, kind?: 'info' | 'ok' | 'error'): void;
  /** 全文索引（useNoteIndex.docs / ready）：待办列表从这里捞 */
  docs: readonly { path: string; content: string }[];
  indexReady: boolean;
  /**
   * 把某篇第 `line` 行的 `- [ ] raw` 标成完成（走 App 的写盘路径：编辑器回灌、索引、同步）。
   * 那一行对不上返回 false，文件不动。
   */
  toggleTask(path: string, line: number, raw: string): Promise<boolean>;
}

export interface Launcher {
  /** 安卓 Tauri 壳里为 true；界面据此决定要不要露出「添加到桌面」 */
  enabled: boolean;
  /** 把一篇笔记钉到桌面（当前库） */
  pinToHome(path: string): Promise<void>;
  /** 一篇笔记刚落盘：推快照（当前库） */
  notePersisted(path: string, text: string): void;
  /** 改名 / 移动后更新小部件绑定（当前库内） */
  remapBindings(ops: readonly { from: string; to: string }[]): void;
  /**
   * 有一个从桌面进来的动作还没执行。启动时「回到上次那篇」要让路：两边各自异步读文件，
   * 谁后读完谁占住编辑区——不让路的话点快捷方式进来可能开的是上次那篇。
   */
  hasPendingAction(): boolean;
}

/** 最近列表每打开一篇就变一次，快捷方式合并着发 */
const SHORTCUT_DEBOUNCE_MS = 800;

export function useLauncher(deps: LauncherDeps): Launcher {
  const enabled = useMemo(() => launcherAvailable(), []);
  const { vault, canSwitchTo, switchVault, files, filesLoaded, mdStamps, recent, currentPath, doc, docs, indexReady } = deps;

  // 最新值走 ref，异步回调 / 执行动作时不吃陈旧闭包
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const vaultId = vault?.id ?? null;

  // ---------------------------------------------------------------- 1. 领动作并执行

  const [action, setAction] = useState<LaunchAction | null>(null);
  /** 与 action 同步的一份（state 要等下一次渲染，而 hasPendingAction 是在别人的 effect 里被问的） */
  const pendingRef = useRef<LaunchAction | null>(null);
  /** 为哪个动作切过库了（按 at 记）：切一次没切成就别再切，落到当前库里试 */
  const switchedFor = useRef<number | null>(null);

  const pull = useCallback(async () => {
    try {
      const a = await takeLaunchAction();
      if (!a) return;
      if (!isActionFresh(a)) return;
      pendingRef.current = a;
      setAction(a);
    } catch (e) {
      console.warn('领取桌面动作失败', e);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void pull();
    let off: (() => void) | null = null;
    let gone = false;
    void onLaunchAction(() => void pull())
      .then((f) => {
        if (gone) f();
        else off = f;
        // 注册监听是异步的：这个空当里到的动作没人通知，注册完再领一次把它兜住
        void pull();
      })
      .catch((e) => console.warn('监听桌面动作失败', e));
    return () => {
      gone = true;
      off?.();
    };
  }, [enabled, pull]);

  useEffect(() => {
    if (!enabled || !action || !vault) return;
    if (action.kind === 'app') {
      pendingRef.current = null;
      setAction(null);
      return;
    }
    // 要开的那篇在别的库：先切过去，等那个库的列表到了再开（本 effect 会因 vault 变化再跑）
    if (action.kind === 'open' && action.vaultId && action.vaultId !== vault.id) {
      if (canSwitchTo(action.vaultId) && switchedFor.current !== action.at) {
        switchedFor.current = action.at;
        switchVault(action.vaultId);
        return;
      }
      // 那个库已经不在了（比如登录后本地库并进了云端库）、或切不过去：在当前库里按路径试一次
    }
    if (!filesLoaded) return;
    pendingRef.current = null;
    setAction(null);
    const cur = depsRef.current;
    if (action.kind === 'new') {
      void cur.createNote();
    } else if (action.kind === 'daily') {
      void cur.openDaily();
    } else if (action.kind === 'open') {
      if (files.includes(action.path)) cur.openInTab(action.path);
      else cur.toast(`「${titleOfPath(action.path)}」已经不在这个库里了`, 'error');
    }
    // 只在 action / vault / 列表就绪度变化时评估；其余都是执行用的最新引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, action, vault?.id, filesLoaded, files]);

  // ---------------------------------------------------------------- 2. 快捷方式

  useEffect(() => {
    if (!enabled || vaultId === null || !filesLoaded) return;
    const t = window.setTimeout(() => {
      setShortcuts(buildShortcuts(vaultId, recent, files, titleOfPath)).catch((e) =>
        console.warn('发布快捷方式失败', e)
      );
      // 5. 「最近笔记」小部件吃同一份最近列表
      const mtimeOf = (p: string) => depsRef.current.metaOf(p)?.mtime ?? 0;
      setRecentNotes(buildRecentNotes(vaultId, recent, files, titleOfPath, mtimeOf)).catch((e) =>
        console.warn('更新最近笔记小部件失败', e)
      );
    }, SHORTCUT_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
    // mdStamps 变了修改时间才会变；metaOf 走 ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, vaultId, filesLoaded, recent, files, mdStamps]);

  // ---------------------------------------------------------------- 3. 快照

  const push = useCallback(
    (vid: number, path: string, text: string, isRecent: boolean) => {
      const mtime = depsRef.current.metaOf(path)?.mtime || Date.now();
      setNoteSnapshot({
        vaultId: vid,
        path,
        title: titleOfPath(path),
        preview: widgetPreview(text),
        mtime,
        recent: isRecent,
      }).catch((e) => console.warn('更新小部件失败', e));
    },
    []
  );

  // 打开一篇 → 它就是"最近的一篇"
  useEffect(() => {
    if (!enabled || vaultId === null || !currentPath || doc === null) return;
    if (!/\.(md|markdown)$/i.test(currentPath)) return;
    push(vaultId, currentPath, doc, true);
    // 只在换篇时推；正文每次击键的变化由 notePersisted（落盘后）负责
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, vaultId, currentPath]);

  const notePersisted = useCallback(
    (path: string, text: string) => {
      if (!enabled) return;
      const v = depsRef.current.vault;
      if (!v) return;
      push(v.id, path, text, path === depsRef.current.currentPath);
    },
    [enabled, push]
  );

  /**
   * 被钉在桌面上的那几篇：文件指纹变了就重读再推。
   * `lastPushed` 记的是"上次推的时候文件长什么样"，同步拉下来 / 外部编辑都会改指纹。
   */
  const lastPushed = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (!enabled || vaultId === null || !filesLoaded) return;
    let cancelled = false;
    void (async () => {
      let bound;
      try {
        bound = await boundNotes();
      } catch (e) {
        console.warn('读取小部件绑定失败', e);
        return;
      }
      if (cancelled || bound.length === 0) return;
      const cur = depsRef.current;
      const v = cur.vault;
      if (!v) return;
      const stampOf = new Map(mdStamps.map((s) => [s.path, `${s.mtime}:${s.size}`]));
      // 库 id 对不上、但当前库里有同路径的（登录后本地库并进云端库就是这样）→ 改绑到当前库
      const rebinds = bound
        .filter((b) => b.vaultId !== v.id && !cur.knowsVault(b.vaultId) && stampOf.has(b.path))
        .map((b) => ({ fromVaultId: b.vaultId, from: b.path, toVaultId: v.id, to: b.path }));
      if (rebinds.length > 0) {
        try {
          await rebindNotes(rebinds);
        } catch (e) {
          console.warn('更新小部件绑定失败', e);
        }
      }
      const mine = new Set([
        ...bound.filter((b) => b.vaultId === v.id).map((b) => b.path),
        ...rebinds.map((r) => r.to),
      ]);
      for (const path of mine) {
        if (cancelled) return;
        const key = `${v.id}|${path}`;
        const stamp = stampOf.get(path) ?? 'gone';
        if (lastPushed.current.get(key) === stamp) continue;
        lastPushed.current.set(key, stamp);
        if (stamp === 'gone') {
          // 文件不在了：卡片上说清楚，别一直挂着最后一次的内容
          setNoteSnapshot({
            vaultId: v.id,
            path,
            title: titleOfPath(path),
            preview: '（这篇笔记已被删除或移走）',
            mtime: 0,
            recent: false,
          }).catch(() => {});
          continue;
        }
        try {
          const text = await cur.io.read(v.localPath ?? '', path);
          if (!cancelled) push(v.id, path, text, false);
        } catch (e) {
          console.warn('读取被钉笔记失败', path, e);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // 指纹列表一变（同步、外部编辑、删除）就对一遍；vault/io 走 ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, vaultId, filesLoaded, mdStamps]);

  const remapBindings = useCallback(
    (ops: readonly { from: string; to: string }[]) => {
      if (!enabled || ops.length === 0) return;
      const v = depsRef.current.vault;
      if (!v) return;
      for (const op of ops) lastPushed.current.delete(`${v.id}|${op.from}`);
      rebindNotes(ops.map((o) => ({ fromVaultId: v.id, from: o.from, toVaultId: v.id, to: o.to }))).catch((e) =>
        console.warn('更新小部件绑定失败', e)
      );
    },
    [enabled]
  );

  // ---------------------------------------------------------------- 6. 待办

  /** 上次推给小部件的列表（序列化后），一样就不再推 */
  const lastTodo = useRef<string>('');

  const pushTodo = useCallback((force = false) => {
    const cur = depsRef.current;
    const v = cur.vault;
    if (!v || !cur.indexReady) return;
    const mtimeOf = (p: string) => cur.metaOf(p)?.mtime ?? 0;
    const items = collectTasks(cur.docs, mtimeOf, titleOfPath);
    const snapshot = { vaultId: v.id, root: v.localPath ?? '', items };
    const key = JSON.stringify(snapshot);
    if (!force && key === lastTodo.current) return;
    lastTodo.current = key;
    setTodoSnapshot(snapshot).catch((e) => console.warn('更新待办小部件失败', e));
  }, []);

  useEffect(() => {
    if (!enabled || vaultId === null || !indexReady) return;
    const t = window.setTimeout(() => pushTodo(), SHORTCUT_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
    // docs 一变（写盘 touch / 同步对账）就重算；其余走 ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, vaultId, indexReady, docs]);

  /** 勾掉一条：改那一行；改不了要说清楚；无论成败都把最新列表推回去（清掉"刚勾掉"的标记） */
  const applyToggle = useCallback(async (item: TodoItem) => {
    const cur = depsRef.current;
    const v = cur.vault;
    if (!v) return;
    if (item.vaultId && item.vaultId !== v.id && cur.knowsVault(item.vaultId)) {
      cur.toast(`「${item.text}」在别的库里，切过去再勾`, 'info');
      return;
    }
    try {
      const ok = await cur.toggleTask(item.path, item.line, item.raw);
      if (!ok) cur.toast(`「${item.text}」这一行已经变了，没有改`, 'error');
    } catch (e) {
      cur.toast(`勾选失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
    // 成功时写盘会 touch 索引、docs 变化会触发上面的 effect；失败时 docs 不变，这里强推一次
    pushTodo(true);
  }, [pushTodo]);

  // 原生推来的「桌面上勾掉了一条」事件；挂上之后告诉原生"我在听"
  useEffect(() => {
    if (!enabled) return;
    let off: (() => void) | null = null;
    let gone = false;
    void onTodoToggle((item) => void applyToggle(item))
      .then((f) => {
        if (gone) {
          f();
          return;
        }
        off = f;
        return setTodoLive(true);
      })
      .catch((e) => console.warn('监听待办勾选失败', e));
    return () => {
      gone = true;
      off?.();
      setTodoLive(false).catch(() => {});
    };
  }, [enabled, applyToggle]);

  // App 没在跑时勾掉的：列表就绪后领走补做（换库也再领一次——排队的可能属于新切到的库）
  useEffect(() => {
    if (!enabled || vaultId === null || !filesLoaded) return;
    let cancelled = false;
    void (async () => {
      let items: TodoItem[];
      try {
        items = await takePendingToggles();
      } catch (e) {
        console.warn('领取待办队列失败', e);
        return;
      }
      for (const item of items) {
        if (cancelled) return;
        await applyToggle(item);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, vaultId, filesLoaded, applyToggle]);

  // ---------------------------------------------------------------- 4. 添加到桌面

  const pinToHome = useCallback(
    async (path: string) => {
      if (!enabled) return;
      const cur = depsRef.current;
      const v = cur.vault;
      if (!v) return;
      try {
        const text = path === cur.currentPath && cur.doc !== null ? cur.doc : await cur.io.read(v.localPath ?? '', path);
        const r = await pinNoteWidget({
          vaultId: v.id,
          path,
          title: titleOfPath(path),
          preview: widgetPreview(text),
          mtime: cur.metaOf(path)?.mtime || Date.now(),
          recent: false,
        });
        if (r.mode === 'bound') {
          cur.toast(`已显示在桌面上的 ${r.count} 张笔记卡片里`, 'ok');
        } else if (r.mode === 'pending') {
          cur.toast('这台手机不支持一键添加：长按桌面空白处 → 添加小部件 → Ivyea Note「笔记卡片」，十分钟内添加的卡片会显示这篇', 'info');
        }
        // requested：系统自己弹了确认框，不用再说什么
      } catch (e) {
        cur.toast(`添加到桌面失败：${e instanceof Error ? e.message : String(e)}`, 'error');
      }
    },
    [enabled]
  );

  const hasPendingAction = useCallback(() => pendingRef.current !== null, []);

  return useMemo(
    () => ({ enabled, pinToHome, notePersisted, remapBindings, hasPendingAction }),
    [enabled, pinToHome, notePersisted, remapBindings, hasPendingAction]
  );
}

/**
 * 安卓桌面入口的前端桥（v0.11.30；v0.11.31 加最近笔记 / 待办）：长按图标快捷方式 + 桌面小部件。
 *
 * 原生那边（plugins/ivnote-launcher）不读笔记文件，只存 JS 推过去的快照、发布 JS 给的
 * 快捷方式列表、把"从桌面进来要做什么"交回来。这个文件是所有原生调用的唯一出口，
 * 并且带平台守卫：**不是安卓 Tauri 壳就一律 no-op**——桌面端、网页版永远不会碰到 invoke。
 *
 * 调用方是 hooks/useLauncher.ts；这里只管把类型和 IPC 摆正。
 */

/** 只有安卓上的 Tauri 壳才有这些原生能力（网页版跑在安卓 Chrome 里也不算） */
export function launcherAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    '__TAURI_INTERNALS__' in window &&
    typeof navigator !== 'undefined' &&
    /android/i.test(navigator.userAgent)
  );
}

/** 从快捷方式 / 小部件进来时要做的事（与 Rust 侧 LaunchAction 一致） */
export interface LaunchAction {
  kind: 'new' | 'daily' | 'open' | 'app';
  /** `open` 时是哪个库；其它为 0 */
  vaultId: number;
  /** `open` 时是哪篇；其它为空串 */
  path: string;
  /** 原生侧收到的毫秒时间戳 */
  at: number;
}

export interface ShortcutSpec {
  kind: 'new' | 'daily' | 'open';
  label: string;
  vaultId: number;
  path: string;
}

export interface NoteSnapshot {
  vaultId: number;
  path: string;
  title: string;
  preview: string;
  mtime: number;
  /** 这篇同时是"最近打开的一篇"：没绑定具体笔记的小部件显示它 */
  recent: boolean;
}

export interface BoundNote {
  vaultId: number;
  path: string;
}

export interface RebindOp {
  fromVaultId: number;
  from: string;
  toVaultId: number;
  to: string;
}

/** 「添加到桌面」的结果，含义见 Rust 侧 PinResult */
export interface PinResult {
  mode: 'requested' | 'bound' | 'pending';
  count: number;
}

async function call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(`plugin:ivnote-launcher|${cmd}`, args);
}

/** 领走待处理的启动动作（领走即清空）；没有就 null */
export async function takeLaunchAction(): Promise<LaunchAction | null> {
  const r = await call<{ action: LaunchAction | null }>('take_launch_action');
  const a = r?.action;
  if (!a || typeof a.kind !== 'string') return null;
  return a;
}

/**
 * 监听原生推来的「有新动作」事件（应用活着时点快捷方式 / 小部件走这条）。
 * 事件只是个提醒，真正的动作仍然通过 takeLaunchAction 领——两条路合成一个入口，
 * 不会因为事件和启动领取撞在一起做两遍。
 */
export async function onLaunchAction(cb: () => void): Promise<() => void> {
  const { addPluginListener } = await import('@tauri-apps/api/core');
  const l = await addPluginListener('ivnote-launcher', 'launch', () => cb());
  return () => void l.unregister();
}

export function setShortcuts(shortcuts: ShortcutSpec[]): Promise<void> {
  return call('set_shortcuts', { shortcuts });
}

export function setNoteSnapshot(snapshot: NoteSnapshot): Promise<void> {
  return call('set_note_snapshot', { snapshot });
}

export function boundNotes(): Promise<BoundNote[]> {
  return call('bound_notes');
}

export function rebindNotes(ops: RebindOp[]): Promise<void> {
  return call('rebind_notes', { ops });
}

export function pinNoteWidget(snapshot: NoteSnapshot): Promise<PinResult> {
  return call('pin_note_widget', { snapshot });
}

// ---------- v0.11.31：最近笔记 / 待办 ----------

export interface RecentNote {
  vaultId: number;
  path: string;
  title: string;
  mtime: number;
}

/** 「最近笔记」小部件的整份列表（顺序即显示顺序） */
export function setRecentNotes(items: RecentNote[]): Promise<void> {
  return call('set_recent_notes', { items });
}

export interface NoteList {
  vaultId: number;
  /** 库在磁盘上的位置（vault.localPath）：配置页刚绑好一篇时原生据此自己读一遍画预览 */
  root: string;
  items: RecentNote[];
}

/** 当前库的全部笔记（v0.11.32）：笔记卡片的配置页从这里列给用户选 */
export function setNoteList(list: NoteList): Promise<void> {
  return call('set_note_list', { list });
}

/** 配置页要列的全部 Markdown 笔记（不含回收站 / 元数据目录），带修改时间 */
export function buildNoteList(
  vaultId: number,
  files: readonly string[],
  titleOf: (path: string) => string,
  mtimeOf: (path: string) => number
): RecentNote[] {
  const out: RecentNote[] = [];
  for (const p of files) {
    if (!/\.(md|markdown)$/i.test(p)) continue;
    if (p.startsWith('.trash/') || p.startsWith('.ivyea/')) continue;
    out.push({ vaultId, path: p, title: titleOf(p), mtime: mtimeOf(p) });
  }
  return out;
}

/** 与 lib/todoTasks 的 TodoTask 同形（原生 / Rust 侧 TodoItem） */
export interface TodoItem {
  /** 只有原生交回来的（事件 / 队列）才带：当时是哪个库的列表 */
  vaultId?: number;
  path: string;
  title: string;
  line: number;
  raw: string;
  text: string;
}

export interface TodoSnapshot {
  vaultId: number;
  /** 库在磁盘上的位置（vault.localPath）：App 没在跑时原生据此决定能不能自己改文件 */
  root: string;
  items: TodoItem[];
}

export function setTodoSnapshot(snapshot: TodoSnapshot): Promise<void> {
  return call('set_todo_snapshot', { snapshot });
}

/** 桌面上勾掉了、原生没能写进文件的（领走即清空） */
export function takePendingToggles(): Promise<TodoItem[]> {
  return call('take_pending_toggles');
}

/** 告诉原生"JS 在听 todo 事件"：在听时勾选交给 JS 改文件，不在听时原生自己来 */
export function setTodoLive(live: boolean): Promise<void> {
  return call('set_todo_live', { live });
}

/** 桌面上勾掉了一条、App 正在跑：原生把这条交过来，JS 改文件 */
export async function onTodoToggle(cb: (item: TodoItem) => void): Promise<() => void> {
  const { addPluginListener } = await import('@tauri-apps/api/core');
  const l = await addPluginListener<TodoItem>('ivnote-launcher', 'todo', (item) => cb(item));
  return () => void l.unregister();
}

/** 最近笔记小部件最多列几行（4×4 也就八行） */
export const RECENT_MAX = 8;

/** 「最近笔记」列表：最近打开的、还在库里的 Markdown，带修改时间 */
export function buildRecentNotes(
  vaultId: number,
  recent: readonly string[],
  files: readonly string[],
  titleOf: (path: string) => string,
  mtimeOf: (path: string) => number,
  max = RECENT_MAX
): RecentNote[] {
  const exists = new Set(files);
  const out: RecentNote[] = [];
  for (const p of recent) {
    if (out.length >= max) break;
    if (!exists.has(p) || !/\.(md|markdown)$/i.test(p)) continue;
    out.push({ vaultId, path: p, title: titleOf(p), mtime: mtimeOf(p) });
  }
  return out;
}

// ---------- 纯函数（便于单测） ----------

/**
 * 长按图标菜单该列哪几条：新建、今日日记，再加最近打开的两篇（还在库里的）。
 * 启动器一般只显示 4 条，多给也是白给。
 */
export function buildShortcuts(
  vaultId: number,
  recent: readonly string[],
  files: readonly string[],
  titleOf: (path: string) => string,
  maxRecent = 2
): ShortcutSpec[] {
  const exists = new Set(files);
  const out: ShortcutSpec[] = [
    { kind: 'new', label: '新建笔记', vaultId: 0, path: '' },
    { kind: 'daily', label: '今日日记', vaultId: 0, path: '' },
  ];
  for (const p of recent) {
    if (out.length >= 2 + maxRecent) break;
    if (!exists.has(p) || !/\.(md|markdown)$/i.test(p)) continue;
    out.push({ kind: 'open', label: titleOf(p), vaultId, path: p });
  }
  return out;
}

/** 太旧的动作不做：比如应用挂在后台半小时前收到的"新建"，现在才轮到 JS 领，用户早忘了 */
export const ACTION_MAX_AGE_MS = 2 * 60 * 1000;

export function isActionFresh(a: LaunchAction, now = Date.now()): boolean {
  return typeof a.at !== 'number' || now - a.at <= ACTION_MAX_AGE_MS;
}

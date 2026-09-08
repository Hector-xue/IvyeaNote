/**
 * 「上次打开的是哪一篇」（v0.11.11）。
 *
 * 用户要的是：关掉应用、再打开，直接停在退出前那篇笔记上（Obsidian、
 * 以及基本上所有编辑器都是这个行为）。此前每次启动都是空白的欢迎页，
 * 哪怕上一秒还在写。
 *
 * 按**库**分开记：切库之后不该跳回另一个库里的文件——路径在两个库里可能
 * 同名不同物，跨库还原等于打开一篇看起来对、其实不是那篇的笔记。
 *
 * 只存路径，不存内容；文件没了就当没记过（下面的 `pickRestore` 负责校验）。
 */
const PREFIX = 'ivnote.lastOpen.';

function key(vaultId: number): string {
  return `${PREFIX}${vaultId}`;
}

export function loadLastOpen(vaultId: number): string | null {
  try {
    return localStorage.getItem(key(vaultId));
  } catch {
    return null;
  }
}

export function saveLastOpen(vaultId: number, path: string | null): void {
  try {
    if (path) localStorage.setItem(key(vaultId), path);
    else localStorage.removeItem(key(vaultId));
  } catch {
    /* 隐私模式 / 存储被禁：记不住就算了，不该让打开笔记这件事失败 */
  }
}

/**
 * 该不该还原、还原哪一篇。纯函数，便于单测。
 *
 * 三条守则：
 * - 已经打开了别的笔记（比如从命令行/链接进来的）就不要抢；
 * - 记着的那篇必须**还在这个库里**，否则会打开一个不存在的路径；
 * - 只还原 Markdown 笔记：PDF、图片这些要走各自的查看器，启动就弹一个 PDF 很吓人。
 */
export function pickRestore(
  remembered: string | null,
  files: readonly string[],
  currentPath: string | null
): string | null {
  if (currentPath) return null;
  if (!remembered) return null;
  if (!/\.(md|markdown)$/i.test(remembered)) return null;
  return files.includes(remembered) ? remembered : null;
}

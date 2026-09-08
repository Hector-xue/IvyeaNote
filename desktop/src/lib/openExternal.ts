/**
 * 把一个文件交给系统的默认程序打开。
 *
 * 为什么要单独一层：系统里**没有**能打开这种文件的程序时，`openPath` 只会抛一句
 * 「没有可用应用」，然后什么也不发生 —— 用户没有任何出路。最典型的就是 Obsidian
 * 的 `.base`：它是 Obsidian 自己的格式，Windows 上没有任何关联程序（2026-09-08
 * 用户报的正是这条）。
 *
 * 退一步的做法是**在文件管理器里定位到它**：至少能右键「打开方式」自己挑一个程序。
 * 定位也失败才把原始错误抛出去 —— 那说明连路径都有问题，不该拿"定位失败"去掩盖。
 */
export type OpenOutcome = 'opened' | 'revealed';

export async function openWithSystem(absPath: string): Promise<OpenOutcome> {
  const { openPath, revealItemInDir } = await import('@tauri-apps/plugin-opener');
  try {
    await openPath(absPath);
    return 'opened';
  } catch (e) {
    try {
      await revealItemInDir(absPath);
      return 'revealed';
    } catch {
      throw e; // 原始错误比"定位也失败了"有用
    }
  }
}

/** 文件名（用于提示语）。两种分隔符都要认：Windows 上拼出来的是反斜杠 */
export function baseNameOf(absPath: string): string {
  const i = Math.max(absPath.lastIndexOf('/'), absPath.lastIndexOf('\\'));
  return i >= 0 ? absPath.slice(i + 1) : absPath;
}

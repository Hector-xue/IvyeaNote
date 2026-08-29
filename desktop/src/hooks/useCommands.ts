/**
 * 命令面板与全局快捷键（从 App.tsx 抽出，v0.8.0 —— 方案 §5 P1.4 点名的 `useCommands`）。
 *
 * 原来这块散在 App.tsx 的三处：面板模式 state、`keydown` 监听、命令表 `useMemo`。
 * 散着的坏处不是行数，是**没人能一眼说清「现在有哪些命令、哪些快捷键」**——
 * 加一个命令要改三处，漏一处就变成「命令表里有、Ctrl+P 里点不到」这类静默缺陷。
 *
 * 收进来之后：命令表是唯一的真相，快捷键表跟它并排放在同一个文件里。
 *
 * 边界：hook 不碰 IO、不认识 vault，只吃调用方给的动作。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CommandItem, PaletteMode } from '../ui/Palette';

/** 命令面板里每一条能干的事。给 null 表示当前条件下这条命令不出现 */
export interface CommandActions {
  onCreateNote(): void;
  onCreateFolder(): void;
  onImportObsidian(): void;
  onOpenDaily(): void;
  onOpenGraph(): void;
  onNewFromTemplate(): void;
  onToggleTheme(): void;
  onOpenSettings(): void;
  onCheckUpdate(): void;
  /** 未登录时为 null：配对码只有账号态下有意义 */
  onAddDevice: (() => void) | null;
  /** 没有笔记库时为 null */
  onOpenTrash: (() => void) | null;
}

export interface CommandsDeps {
  /** 没有笔记库时，三个面板都不该弹出来（但 Ctrl+, 的设置照常可用） */
  enabled: boolean;
  theme: 'light' | 'dark';
  appVersion: string;
  actions: CommandActions;
}

export interface Commands {
  paletteMode: PaletteMode | null;
  openPalette(mode: PaletteMode): void;
  closePalette(): void;
  commands: CommandItem[];
}

export function useCommands(deps: CommandsDeps): Commands {
  const { enabled, theme, appVersion, actions } = deps;
  const [paletteMode, setPaletteMode] = useState<PaletteMode | null>(null);

  const openPalette = useCallback(
    (mode: PaletteMode) => {
      if (!enabled) return;
      setPaletteMode(mode);
    },
    [enabled]
  );
  const closePalette = useCallback(() => setPaletteMode(null), []);

  /**
   * 全局快捷键。与命令表放在同一个文件里，是为了改一处时另一处就在眼皮底下。
   * Ctrl+, 不走 openPalette：设置在没有笔记库时也该能开（否则新用户改不了主题）。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'k') {
        e.preventDefault();
        openPalette('search');
      } else if (k === 'o') {
        e.preventDefault();
        openPalette('switcher');
      } else if (e.key === ',') {
        // Ctrl+, 是各家设置的通用快捷键（macOS 是 Cmd+,）
        e.preventDefault();
        actions.onOpenSettings();
      } else if (k === 'p') {
        e.preventDefault();
        openPalette('commands');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openPalette, actions]);

  const commands: CommandItem[] = useMemo(
    () =>
      [
        { id: 'new-note', label: '新建笔记', run: actions.onCreateNote },
        { id: 'new-folder', label: '新建文件夹', run: actions.onCreateFolder },
        { id: 'import-obsidian', label: '从 Obsidian 导入', run: actions.onImportObsidian },
        { id: 'daily', label: '打开今日笔记', run: actions.onOpenDaily },
        { id: 'graph', label: '打开图谱视图', run: actions.onOpenGraph },
        { id: 'from-template', label: '从模板新建笔记', run: actions.onNewFromTemplate },
        {
          id: 'toggle-theme',
          label: theme === 'light' ? '切换到深色主题' : '切换到浅色主题',
          run: actions.onToggleTheme,
        },
        actions.onAddDevice
          ? { id: 'add-device', label: '添加设备（配对码）', run: actions.onAddDevice }
          : null,
        { id: 'settings', label: '设置', run: actions.onOpenSettings },
        actions.onOpenTrash
          ? { id: 'trash', label: '打开回收站', run: actions.onOpenTrash }
          : null,
        // v0.7.2：应用内更新入口（手动检查）
        { id: 'check-update', label: `检查更新（当前 v${appVersion}）`, run: actions.onCheckUpdate },
      ].filter((c): c is CommandItem => c !== null),
    [actions, theme, appVersion]
  );

  return { paletteMode, openPalette, closePalette, commands };
}

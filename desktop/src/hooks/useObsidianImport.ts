/**
 * 从 Obsidian 库一键导入（从 App.tsx 抽出，v0.8.0 P1.4）。
 *
 * 原来是一个百来行的 `useCallback`，里面 if/else 分成桌面与浏览器两条完全独立的路，
 * **写盘循环、进度更新、结果文案各写了两遍**。两遍就会漂：v0.4.0 之后浏览器那条的
 * 进度计数用的是 `n + failed.length`、桌面那条用的是 `i + 1`，同一件事两种算法。
 *
 * 现在两条路只负责「把文件枚举成 `{ rel, getText }`」，写盘 / 进度 / 文案共用一份。
 */
import { useCallback, useState } from 'react';
import type { FileIO } from '../lib/sync';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** 待导入的一篇：相对路径 + 取正文（正文按需读，避免一次性把整库读进内存） */
export interface ImportEntry {
  rel: string;
  getText(): Promise<string>;
}

export interface ImportProgress {
  done: number;
  total: number;
}

const MD = /\.(md|markdown)$/i;

/**
 * 浏览器退化路径（没有 showDirectoryPicker 时）：`<input webkitdirectory>` 选出来的
 * File 列表 → 导入条目。`webkitRelativePath` 的第一段是用户选的那个文件夹名本身，
 * 要去掉——否则导进来的笔记全被套进一层「MyVault/」目录里。
 */
export function entriesFromPickedFiles(files: readonly File[]): ImportEntry[] {
  return files
    .filter((f) => MD.test(f.name))
    .map((f) => ({
      rel:
        (f as File & { webkitRelativePath?: string }).webkitRelativePath
          ?.split('/')
          .slice(1)
          .join('/') || f.name,
      getText: () => f.text(),
    }));
}

/** 导入结果文案：成功/失败两种口径只写一处 */
export function importMessage(
  ok: number,
  failed: readonly string[],
  willSync: boolean
): { msg: string; kind: 'ok' | 'error' } {
  if (failed.length === 0) {
    return {
      msg: `已从 Obsidian 导入 ${ok} 个笔记${willSync ? '，正在同步到服务器…' : ''}`,
      kind: 'ok',
    };
  }
  return {
    msg: `导入完成：成功 ${ok} 个，失败 ${failed.length} 个（首个失败：${failed[0]}）`,
    kind: 'error',
  };
}

export interface ObsidianImportDeps {
  vaultPath: string | null;
  io: FileIO;
  refreshFiles(): Promise<void>;
  /** 已登录时导入完自动推一次；未登录传 null */
  afterImport: (() => void) | null;
  toast(msg: string, kind: 'ok' | 'error'): void;
  errText(e: unknown): string;
}

export interface ObsidianImport {
  importing: boolean;
  progress: ImportProgress | null;
  run(): Promise<void>;
}

/** 桌面端：选文件夹 → 递归枚举 md（跳过 .obsidian 等隐藏目录） */
async function collectTauri(): Promise<ImportEntry[] | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const dir = await open({ directory: true, title: '选择 Obsidian 库文件夹' });
  if (typeof dir !== 'string') return null;
  const { readDir, readTextFile } = await import('@tauri-apps/plugin-fs');
  const out: ImportEntry[] = [];
  const walk = async (d: string, prefix: string) => {
    for (const e of await readDir(d)) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory) {
        if (!e.name.startsWith('.')) await walk(`${d}/${e.name}`, rel);
      } else if (MD.test(e.name)) {
        const abs = `${d}/${e.name}`;
        out.push({ rel, getText: () => readTextFile(abs) });
      }
    }
  };
  await walk(dir, '');
  return out;
}

type DirHandleLike = {
  values(): AsyncIterableIterator<{ kind: string; name: string; getFile(): Promise<File> }>;
};

/** 浏览器端：优先目录句柄（保留子目录结构），否则退化成文件夹多选 */
async function collectBrowser(): Promise<ImportEntry[]> {
  const wdp = (window as unknown as { showDirectoryPicker?: () => Promise<DirHandleLike> })
    .showDirectoryPicker;
  if (!wdp) {
    const picked = await new Promise<File[]>((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      (input as HTMLInputElement & { webkitdirectory?: boolean }).webkitdirectory = true;
      input.onchange = () => resolve(Array.from(input.files ?? []));
      input.click();
    });
    return entriesFromPickedFiles(picked);
  }
  const root = await wdp.call(window);
  const out: ImportEntry[] = [];
  const walk = async (d: DirHandleLike, prefix: string) => {
    for await (const h of d.values()) {
      const rel = prefix ? `${prefix}/${h.name}` : h.name;
      if (h.kind === 'directory') {
        if (!h.name.startsWith('.')) await walk(h as unknown as DirHandleLike, rel);
      } else if (MD.test(h.name)) {
        out.push({ rel, getText: () => h.getFile().then((f) => f.text()) });
      }
    }
  };
  await walk(root, '');
  return out;
}

export function useObsidianImport(deps: ObsidianImportDeps): ObsidianImport {
  const { vaultPath, io, refreshFiles, afterImport, toast, errText } = deps;
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);

  const run = useCallback(async () => {
    if (vaultPath === null || importing) return;
    setImporting(true);
    setProgress({ done: 0, total: 0 });
    try {
      const entries = isTauri ? await collectTauri() : await collectBrowser();
      if (entries === null) return; // 用户取消了选择
      // 写盘 / 进度 / 文案：两条路共用这一份
      const failed: string[] = [];
      setProgress({ done: 0, total: entries.length });
      for (let i = 0; i < entries.length; i++) {
        try {
          await io.write(vaultPath, entries[i].rel, await entries[i].getText());
        } catch {
          failed.push(entries[i].rel); // 单文件失败不中断整体导入
        }
        setProgress({ done: i + 1, total: entries.length });
      }
      const { msg, kind } = importMessage(entries.length - failed.length, failed, !!afterImport);
      toast(msg, kind);
      await refreshFiles();
      afterImport?.();
    } catch (e) {
      toast(`导入失败：${errText(e)}`, 'error');
    } finally {
      setImporting(false);
      setProgress(null);
    }
  }, [vaultPath, importing, io, refreshFiles, afterImport, toast, errText]);

  return { importing, progress, run };
}

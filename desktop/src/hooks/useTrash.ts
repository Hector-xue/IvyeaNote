/**
 * 回收站（从 App.tsx 抽出，v0.7.8）。
 *
 * 删除不物理删，先移进 `.trash/时间戳-原路径`（目录分隔符编码成 `__`），
 * 恢复时反解回原路径。三个操作（列出 / 恢复 / 彻底删除）此前散在 App.tsx 的
 * 三个不相邻的位置，改一处很容易忘掉另一处。
 */
import { useCallback, useState } from 'react';
import type { FileIO } from '../lib/sync';

const TRASH_DIR = '.trash/';
/** 回收站文件名前缀：2026-08-29T11-22-33- */
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/;

/** 由回收站路径反解出原始相对路径 */
export function originalPathOf(trashPath: string): string {
  const base = trashPath.split('/').pop() ?? '';
  return base.replace(STAMP_RE, '').replaceAll('__', '/');
}

/** 生成回收站落点（重名时追加 -1，调用方需保证最终不冲突） */
export function trashPathFor(path: string, now = new Date()): string {
  const base = path.replaceAll('/', '__');
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${TRASH_DIR}${stamp}-${base}`;
}

export interface TrashDeps {
  io: FileIO;
  /** vault 根路径；null 表示尚未绑定库，所有操作都会安全地什么也不做 */
  vaultPath: string | null;
  refreshFiles(): Promise<void>;
  sync(): void;
  toast(msg: string, kind?: 'info' | 'ok' | 'error'): void;
  confirm(opts: {
    title: string;
    description?: string;
    okText?: string;
    danger?: boolean;
  }): Promise<boolean>;
  errText(e: unknown): string;
}

export interface Trash {
  list: string[];
  open: boolean;
  setOpen(v: boolean): void;
  /** 列出 .trash/ 下全部条目并打开面板 */
  reload(): Promise<void>;
  /** 恢复到原路径（同名已存在则拒绝，不覆盖用户现有笔记） */
  restore(trashPath: string): Promise<void>;
  /** 彻底删除（走确认框，不可恢复） */
  purge(trashPath: string): Promise<void>;
}

export function useTrash(deps: TrashDeps): Trash {
  const { io, vaultPath, refreshFiles, sync, toast, confirm, errText } = deps;
  const [list, setList] = useState<string[]>([]);
  const [open, setOpen] = useState(false);

  const reload = useCallback(async () => {
    if (vaultPath === null) return;
    try {
      const all = (await io.list(vaultPath)).filter((p) => p.startsWith(TRASH_DIR));
      setList(all);
      setOpen(true);
    } catch (e) {
      toast(`读取回收站失败：${errText(e)}`, 'error');
    }
  }, [io, vaultPath, toast, errText]);

  const restore = useCallback(
    async (trashPath: string) => {
      if (vaultPath === null) return;
      const original = originalPathOf(trashPath);
      try {
        if (await io.exists(vaultPath, original)) {
          toast(`恢复失败：${original} 已存在同名笔记`, 'error');
          return;
        }
        const content = await io.read(vaultPath, trashPath);
        await io.write(vaultPath, original, content);
        await io.remove(vaultPath, trashPath);
        setList((l) => l.filter((p) => p !== trashPath));
        await refreshFiles();
        sync();
        toast(`已恢复：${original}`, 'ok');
      } catch (e) {
        toast(`恢复失败：${errText(e)}`, 'error');
      }
    },
    [io, vaultPath, refreshFiles, sync, toast, errText]
  );

  const purge = useCallback(
    async (trashPath: string) => {
      if (vaultPath === null) return;
      const ok = await confirm({
        title: '彻底删除',
        description: `${trashPath} 将被永久删除，不可恢复。`,
        okText: '永久删除',
        danger: true,
      });
      if (!ok) return;
      try {
        await io.remove(vaultPath, trashPath);
        setList((l) => l.filter((p) => p !== trashPath));
        await refreshFiles();
        sync();
      } catch (e) {
        toast(`删除失败：${errText(e)}`, 'error');
      }
    },
    [io, vaultPath, refreshFiles, sync, confirm, toast, errText]
  );

  return { list, open, setOpen, reload, restore, purge };
}

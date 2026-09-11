/**
 * 回收站（从 App.tsx 抽出，v0.7.8）。
 *
 * 删除不物理删，先移进 `.trash/时间戳-原路径`（目录分隔符编码成 `__`），
 * 恢复时反解回原路径。三个操作（列出 / 恢复 / 彻底删除）此前散在 App.tsx 的
 * 三个不相邻的位置，改一处很容易忘掉另一处。
 */
import { useCallback, useState } from 'react';
import type { FileIO } from '../lib/sync';
import { TRASH_DIR, originalPathOf } from '../lib/trashPath';

/*
 * v0.11.24：路径规则（TRASH_DIR / originalPathOf / nextTrashName / trashPathFor）
 * 搬到了 lib/trashPath——同步引擎收到远端删除时也要往回收站里放，lib 不能倒过来
 * 依赖 hooks。这里原样再导出，调用方一个不用改。
 */
export { TRASH_DIR, originalPathOf, nextTrashName, trashPathFor } from '../lib/trashPath';

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
  /** 一次确认清空整个回收站 */
  purgeAll(): Promise<void>;
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
        /*
         * **按二进制搬**。此前恢复走的是 read/write 文本：图片、PDF 这些一旦经过
         * `readTextFile` 的 UTF-8 解码就再也回不来了——要么当场抛错（于是"恢复不了"），
         * 要么被有损解码成一堆替换字符写回去（文件还在、内容已经废了）。
         */
        const bytes = await io.readBinary(vaultPath, trashPath);
        await io.writeBinary(vaultPath, original, bytes);
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

  /**
   * v0.11.16：**清空回收站**。
   *
   * 回收站面板搬进左栏之后，"一条条点彻底删除"就成了一件很蠢的事——
   * 十几个文件要确认十几次。这里只确认一次，然后逐个删；中途失败不吞：
   * 删掉几个就报几个，剩下的还在列表里。
   */
  const purgeAll = useCallback(async () => {
    if (vaultPath === null || list.length === 0) return;
    const ok = await confirm({
      title: '清空回收站',
      description: `${list.length} 个文件将被永久删除，不可恢复。`,
      okText: '永久删除',
      danger: true,
    });
    if (!ok) return;
    const failed: string[] = [];
    for (const p of list) {
      try {
        await io.remove(vaultPath, p);
      } catch {
        failed.push(p);
      }
    }
    setList(failed);
    await refreshFiles();
    sync();
    if (failed.length > 0) toast(`还有 ${failed.length} 个没删掉`, 'error');
    else toast('回收站已清空', 'ok');
  }, [io, vaultPath, list, refreshFiles, sync, confirm, toast]);

  return { list, open, setOpen, reload, restore, purge, purgeAll };
}

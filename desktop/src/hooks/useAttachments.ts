/**
 * 附件：插图 / 粘贴图片 / 阅读态图片解析 / PDF 预览（从 App.tsx 抽出，v0.8.0 P1.4）。
 *
 * 抽出来的两个额外收获（和 useTabs 当初一样，是搬家时才看见的）：
 *
 * 1. **落盘取名的逻辑本来有两份**：`onInsertImage` 和 `onPasteImage` 各写了一遍
 *    「Attachments/日期-原名，重名加序号」。两份就会漂——改一处忘一处，两条路径
 *    存出来的名字规则就不一样了。现在只有 `uniqueAttachmentPath` 一个出口。
 * 2. **切换笔记库时图片缓存没清**：缓存键是相对路径（`Attachments/xx.png`），
 *    两个库里同名的图片会撞上——切过去还显示上一个库的那张。缓存现在跟着
 *    vaultPath 走，换库即清并回收 blob URL（原来这些 URL 一直到关窗口都不释放）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileIO } from '../lib/sync';
import { attachmentDir, joinPath, type AttachMode } from '../lib/attachPath';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * 附件落盘的唯一取名出口：`<目录>/日期-原名`，重名加 -1 -2…
 *
 * v0.10.7：目录从写死的 `Attachments/` 改成由调用方按设置算好传进来
 * （见 `lib/attachPath.ts`）。取名规则一个字没动。
 */
export async function uniqueAttachmentPath(
  name: string,
  exists: (rel: string) => Promise<boolean>,
  dir = 'Attachments'
): Promise<string> {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const safe = `${stamp}-${name.replace(/[\\/]/g, '_')}`;
  let rel = joinPath(dir, safe);
  let i = 1;
  while (await exists(rel)) {
    rel = joinPath(dir, safe.replace(/(\.[a-z0-9]+)$/i, `-${i}$1`));
    i++;
  }
  return rel;
}

/** 由扩展名推 MIME（只覆盖图片；拿不准就按 image/<ext> 走，浏览器会兜住） */
export function imageMime(rel: string): string {
  const ext = rel.split('.').pop()?.toLowerCase() ?? 'png';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'jpg') return 'image/jpeg';
  return `image/${ext}`;
}

export interface AttachmentsDeps {
  /** 当前库的本地路径；null / undefined 表示没有库，所有动作直接返回 */
  vaultPath: string | null;
  io: FileIO;
  refreshFiles(): Promise<void>;
  doSync(): void;
  toast(msg: string, kind: 'ok' | 'error'): void;
  /** 要显示 PDF 了：主区是互斥的，调用方借此清空编辑器 */
  onShowPdf(): void;
  /** 附件存放位置（设置项）。落点算法在 lib/attachPath.ts */
  attachMode: AttachMode;
  errText(e: unknown): string;
}

export interface Attachments {
  /** 非 null 时主区显示 PDF（值是 blob URL） */
  pdfView: string | null;
  /**
   * 正在预览的 PDF 的**库内路径**。
   *
   * v0.11.0 新增，因为只有 `pdfView` 时消费方拿不到路径，于是两处都错着：
   * 编辑区上方那行面包屑打印的是 `blob:tauri://…` 一长串，而侧栏
   * 「哪个 PDF 是当前打开的」判定写的是 `pdfView === n.path`——
   * 一个 blob URL 永远不等于一个相对路径，高亮从来没亮过。
   */
  pdfPath: string | null;
  /**
   * 选图 → 按设置落盘 → 返回**库内**相对路径（null = 取消或无库）。
   * `notePath` 决定落在哪：附件要跟着笔记走，就得知道是哪一篇。
   */
  insertImage(notePath: string | null): Promise<string | null>;
  /** 粘贴 / 拖入的图片按设置落盘 → 返回库内相对路径 */
  saveImageFile(file: File, notePath: string | null): Promise<string | null>;
  /** 阅读态：相对路径 → 可显示的 blob URL */
  resolveImage(rel: string): Promise<string | null>;
  openPdf(path: string): Promise<void>;
  /**
   * 交给系统应用打开库内的任意文件（只有绑定了磁盘文件夹的库才可能成功）。
   * v0.11.1 起不只服务 PDF：文件树现在显示全部文件，docx/zip 这类我们不打算
   * 自己渲染的，点开就该交给系统。
   */
  openWithSystemApp(path: string): Promise<void>;
  closePdf(): void;
}

export function useAttachments(deps: AttachmentsDeps): Attachments {
  const { vaultPath, io, refreshFiles, doSync, toast, onShowPdf, errText, attachMode } = deps;
  const [pdfView, setPdfView] = useState<string | null>(null);
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  const pdfUrlRef = useRef<string | null>(null);
  const imgCache = useRef<Map<string, string>>(new Map());

  const root = vaultPath ?? '';
  const hasVault = vaultPath !== null;

  // 换库（或卸载）就把上一个库的 blob URL 全部回收：缓存键是相对路径，
  // 不清就会出现「两个库里同名图片串台」，且这些 URL 原本永不释放。
  useEffect(() => {
    const cache = imgCache.current;
    return () => {
      for (const url of cache.values()) URL.revokeObjectURL(url);
      cache.clear();
    };
  }, [vaultPath]);

  const exists = useCallback(
    (rel: string) => io.exists(root, rel).catch(() => false),
    [io, root]
  );

  const insertImage = useCallback(async (notePath: string | null): Promise<string | null> => {
    if (!hasVault) return null;
    const picked: { name: string; data: Uint8Array }[] = [];
    if (isTauri) {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const { readFile } = await import('@tauri-apps/plugin-fs');
      const sel = await open({ multiple: true, title: '选择图片' });
      const paths = Array.isArray(sel) ? sel : sel ? [sel] : [];
      for (const p of paths) {
        if (typeof p !== 'string') continue;
        const data = await readFile(p);
        picked.push({ name: p.split(/[\\/]/).pop() ?? 'image.png', data });
      }
    } else {
      const filesPicked = await new Promise<File[]>((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = () => resolve(Array.from(input.files ?? []));
        input.click();
      });
      for (const f of filesPicked) {
        picked.push({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
      }
    }
    if (picked.length === 0) return null;
    const first = picked[0];
    const rel = await uniqueAttachmentPath(first.name, exists, attachmentDir(attachMode, notePath));
    await io.writeBinary(root, rel, first.data);
    await refreshFiles();
    doSync();
    return rel;
  }, [hasVault, io, root, exists, refreshFiles, doSync, attachMode]);

  const saveImageFile = useCallback(
    async (file: File, notePath: string | null): Promise<string | null> => {
      if (!hasVault) return null;
      const data = new Uint8Array(await file.arrayBuffer());
      const rel = await uniqueAttachmentPath(file.name, exists, attachmentDir(attachMode, notePath));
      await io.writeBinary(root, rel, data);
      await refreshFiles();
      doSync();
      return rel;
    },
    [hasVault, io, root, exists, refreshFiles, doSync, attachMode]
  );

  const resolveImage = useCallback(
    async (rel: string): Promise<string | null> => {
      if (!hasVault) return null;
      const cached = imgCache.current.get(rel);
      if (cached) return cached;
      const bytes = await io.readBinary(root, rel);
      const url = URL.createObjectURL(
        new Blob([bytes as unknown as BlobPart], { type: imageMime(rel) })
      );
      imgCache.current.set(rel, url);
      return url;
    },
    [hasVault, io, root]
  );

  /**
   * 交给系统 PDF 应用。v0.11.0 之前这是**安卓上唯一的一条路**（WebView 不内嵌
   * PDF），现在降级成一个可选动作：应用内已经有 pdf.js 阅读器了，三端一致。
   * 只有绑了磁盘文件夹才可能成功——OPFS 库的文件在浏览器沙箱里，系统看不见。
   */
  const openWithSystemApp = useCallback(
    async (path: string) => {
      if (!vaultPath || vaultPath.startsWith('opfs://')) {
        toast('这个库存在应用内部，系统应用打不开；请先在设置里绑定磁盘文件夹', 'error');
        return;
      }
      try {
        const { openPath } = await import('@tauri-apps/plugin-opener');
        await openPath(`${vaultPath.replace(/\/$/, '')}/${path}`);
      } catch (e) {
        toast(`无法打开：${errText(e)}`, 'error');
      }
    },
    [vaultPath, toast, errText]
  );

  const openPdf = useCallback(
    async (path: string) => {
      if (!hasVault) return;
      try {
        const bytes = await io.readBinary(root, path);
        if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
        const url = URL.createObjectURL(
          new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' })
        );
        pdfUrlRef.current = url;
        onShowPdf();
        setPdfView(url);
        setPdfPath(path);
      } catch (e) {
        toast(`打开 PDF 失败：${errText(e)}`, 'error');
      }
    },
    [hasVault, io, root, toast, onShowPdf, errText]
  );

  const closePdf = useCallback(() => {
    if (pdfUrlRef.current) {
      URL.revokeObjectURL(pdfUrlRef.current);
      pdfUrlRef.current = null;
    }
    setPdfView(null);
    setPdfPath(null);
  }, []);

  return { pdfView, pdfPath, insertImage, saveImageFile, resolveImage, openPdf, openWithSystemApp, closePdf };
}

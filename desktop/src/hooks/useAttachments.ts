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

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);

/** 附件落盘的唯一取名出口：Attachments/日期-原名，重名加 -1 -2… */
export async function uniqueAttachmentPath(
  name: string,
  exists: (rel: string) => Promise<boolean>
): Promise<string> {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let rel = `Attachments/${stamp}-${name.replace(/[\\/]/g, '_')}`;
  let i = 1;
  while (await exists(rel)) {
    rel = rel.replace(/(\.[a-z0-9]+)$/i, `-${i}$1`);
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
  errText(e: unknown): string;
}

export interface Attachments {
  /** 非 null 时主区显示 PDF（值是 blob URL） */
  pdfView: string | null;
  /** 选图 → 拷进 Attachments/ → 返回相对路径（null = 取消或无库） */
  insertImage(): Promise<string | null>;
  /** 粘贴 / 拖入的图片存进 Attachments/ → 返回相对路径 */
  saveImageFile(file: File): Promise<string | null>;
  /** 阅读态：相对路径 → 可显示的 blob URL */
  resolveImage(rel: string): Promise<string | null>;
  openPdf(path: string): Promise<void>;
  closePdf(): void;
}

export function useAttachments(deps: AttachmentsDeps): Attachments {
  const { vaultPath, io, refreshFiles, doSync, toast, onShowPdf, errText } = deps;
  const [pdfView, setPdfView] = useState<string | null>(null);
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

  const insertImage = useCallback(async (): Promise<string | null> => {
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
    const rel = await uniqueAttachmentPath(first.name, exists);
    await io.writeBinary(root, rel, first.data);
    await refreshFiles();
    doSync();
    return rel;
  }, [hasVault, io, root, exists, refreshFiles, doSync]);

  const saveImageFile = useCallback(
    async (file: File): Promise<string | null> => {
      if (!hasVault) return null;
      const data = new Uint8Array(await file.arrayBuffer());
      const rel = await uniqueAttachmentPath(file.name, exists);
      await io.writeBinary(root, rel, data);
      await refreshFiles();
      doSync();
      return rel;
    },
    [hasVault, io, root, exists, refreshFiles, doSync]
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

  const openPdf = useCallback(
    async (path: string) => {
      if (!hasVault) return;
      // 安卓的 WebView 不内嵌 PDF，交给系统应用打开
      if (isAndroid && vaultPath && !vaultPath.startsWith('opfs://')) {
        try {
          const { openPath } = await import('@tauri-apps/plugin-opener');
          await openPath(`${vaultPath.replace(/\/$/, '')}/${path}`);
        } catch (e) {
          toast(`无法打开 PDF：${errText(e)}`, 'error');
        }
        return;
      }
      try {
        const bytes = await io.readBinary(root, path);
        if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
        const url = URL.createObjectURL(
          new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' })
        );
        pdfUrlRef.current = url;
        onShowPdf();
        setPdfView(url);
      } catch (e) {
        toast(`打开 PDF 失败：${errText(e)}`, 'error');
      }
    },
    [hasVault, vaultPath, io, root, toast, onShowPdf, errText]
  );

  const closePdf = useCallback(() => {
    if (pdfUrlRef.current) {
      URL.revokeObjectURL(pdfUrlRef.current);
      pdfUrlRef.current = null;
    }
    setPdfView(null);
  }, []);

  return { pdfView, insertImage, saveImageFile, resolveImage, openPdf, closePdf };
}

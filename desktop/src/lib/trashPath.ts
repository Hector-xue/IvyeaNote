/**
 * 回收站路径规则（v0.11.24 从 hooks/useTrash 抽出来的纯函数）。
 *
 * 抽出来的原因：同步引擎（lib/sync）现在也要往回收站里放东西——别的设备删了一篇，
 * 这台机器 pull 到 delete 时不再直接 `remove`，而是先挪进自己的回收站。
 * lib 层不该反过来依赖 hooks 层，所以规则本身住在这里，hook 只是再导出。
 *
 * 规则：删除不物理删，先移进 `.trash/时间戳-原路径`（目录分隔符编码成 `__`），
 * 恢复时反解回原路径。
 */

export const TRASH_DIR = '.trash/';
/** 回收站文件名前缀：2026-08-29T11-22-33- */
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/;

/** 由回收站路径反解出原始相对路径 */
export function originalPathOf(trashPath: string): string {
  const base = trashPath.split('/').pop() ?? '';
  return base.replace(STAMP_RE, '').replaceAll('__', '/');
}

/**
 * 回收站里重名时的下一个候选：序号加在**扩展名之前**。
 *
 * 此前调用方写死 `replace(/(\.md)$/i, '-1$1')` —— 非 .md 文件（图片 / PDF）压根
 * 匹配不上，`while (exists)` 那个循环于是原地打转，**删一张同名图片能把界面卡死**。
 */
export function nextTrashName(rel: string): string {
  const dot = rel.lastIndexOf('.');
  const base = dot > 0 ? rel.slice(0, dot) : rel;
  const ext = dot > 0 ? rel.slice(dot) : '';
  const m = /^(.*)-(\d+)$/.exec(base);
  return m ? `${m[1]}-${Number(m[2]) + 1}${ext}` : `${base}-1${ext}`;
}

/** 生成回收站落点（重名时用 nextTrashName 递增） */
export function trashPathFor(path: string, now = new Date()): string {
  const base = path.replaceAll('/', '__');
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${TRASH_DIR}${stamp}-${base}`;
}

/**
 * 库怎么称呼（v0.11.25）。
 *
 * 用户原话：「我认为库名就应该是文件夹名字」。库绑了真实文件夹之后，那个文件夹就是
 * 这个库——名字另起一个只会多一层要记的东西（"我的笔记"到底是哪个文件夹？）。
 * 所以：绑了文件夹的库，显示名 = 文件夹名；没绑的（应用内部存储 / Web 版）才用存的名字。
 */
import type { VaultMeta } from './store';

/** 路径的最后一段：`D:\\notes\\工作` → 工作；`/home/a/notes/` → notes */
export function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const base = i < 0 ? trimmed : trimmed.slice(i + 1);
  return base || trimmed;
}

/** 安卓 SAF 树 URI 里把人能读的那截抠出来：`…/tree/primary%3ADocuments%2FIvyeaNote` → Documents/IvyeaNote */
export function safDisplayPath(uri: string): string {
  const m = /\/tree\/([^/?#]+)/.exec(uri);
  if (!m) return uri;
  let seg = m[1];
  try {
    seg = decodeURIComponent(seg);
  } catch {
    // 解不开就原样
  }
  const colon = seg.indexOf(':');
  const volume = colon >= 0 ? seg.slice(0, colon) : '';
  const rest = colon >= 0 ? seg.slice(colon + 1) : seg;
  const vol = volume === 'primary' || volume === '' ? '' : `${volume}/`;
  return rest ? `${vol}${rest}` : vol || uri;
}

export function isSafUri(path: string | undefined): boolean {
  return !!path && path.startsWith('content://');
}

/** 给人看的位置：磁盘路径原样；SAF 换算成 Documents/… ；内部存储写明 */
export function vaultLocationLabel(v: Pick<VaultMeta, 'localPath' | 'localLabel'>): string {
  const p = v.localPath;
  if (!p || p.startsWith('opfs://')) return '应用内部存储';
  if (isSafUri(p)) return v.localLabel && !safDisplayPath(p).endsWith(v.localLabel) ? v.localLabel : safDisplayPath(p);
  return p;
}

/** 显示名：绑了文件夹 = 文件夹名；否则存的名字 */
export function vaultDisplayName(v: Pick<VaultMeta, 'name' | 'localPath' | 'localLabel'>): string {
  const p = v.localPath;
  if (!p || p.startsWith('opfs://')) return v.name;
  if (isSafUri(p)) return v.localLabel || folderName(safDisplayPath(p)) || v.name;
  return folderName(p) || v.name;
}

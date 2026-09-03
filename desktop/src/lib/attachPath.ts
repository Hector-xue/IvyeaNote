/**
 * 附件落点与链接写法（v0.10.7）。
 *
 * 修的是一个**写错和读错互相掩盖**的老问题：
 * 插图时写进正文的是 `![](Attachments/x.png)` —— 这是**库根相对**路径；
 * 而 Markdown 的规矩是**相对笔记文件自己**。笔记只要在子目录里，
 * `子目录/周报.md` 里的 `Attachments/x.png` 在 Obsidian / VSCode / GitHub
 * 眼里就是 `子目录/Attachments/x.png`，图全裂。
 *
 * 应用里看不出来，是因为读的时候 `resolveImage(src)` 也拿库根去解析 ——
 * 两头一起错，自洽，但**只在这个应用里自洽**。而「笔记就是普通 .md 文件、
 * 别的编辑器也能打开」是这个产品的头一条承诺。
 *
 * 所以这里只做两件纯函数的事：**附件该落在哪**、**正文里该写成什么**。
 */

/** 附件存放位置。默认值见 `prefs.ts`，改默认要先想清楚老用户会怎样 */
export type AttachMode =
  /** 库根的 Attachments/（v0.10.6 及以前的唯一行为） */
  | 'vault'
  /** 与笔记同一个文件夹 */
  | 'beside'
  /** 笔记同级的 Attachments/ 子文件夹 */
  | 'subfolder';

/** 附件文件夹名。与 Obsidian 一致地固定成 Attachments，不额外做成设置项 */
export const ATTACH_DIR = 'Attachments';

/** 某个路径所在的目录（库内相对；根目录返回空串） */
export function dirOf(path: string | null | undefined): string {
  if (!path) return '';
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/**
 * 附件该落在哪个目录（库内相对路径，空串＝库根）。
 * `notePath` 为空（还没打开笔记）时一律退回库根，不然会落进一个没人预期的地方。
 */
export function attachmentDir(mode: AttachMode, notePath: string | null): string {
  const dir = dirOf(notePath);
  if (!notePath) return ATTACH_DIR;
  if (mode === 'beside') return dir;
  if (mode === 'subfolder') return dir ? `${dir}/${ATTACH_DIR}` : ATTACH_DIR;
  return ATTACH_DIR;
}

/** 拼接库内路径，避免根目录时多出一个前导斜杠 */
export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/**
 * 从 `fromNote` 指向 `target` 的**笔记相对**路径 —— 也就是该写进正文的那个。
 *
 * 同目录 → `图.png`；上跳 → `../Attachments/图.png`。
 * 注意 Markdown 里 `./` 是多余的，`同目录/图.png` 直接写文件名就够。
 */
export function noteRelative(fromNote: string | null, target: string): string {
  const from = dirOf(fromNote).split('/').filter(Boolean);
  const to = target.split('/').filter(Boolean);
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  const ups = from.length - i;
  return [...Array<string>(ups).fill('..'), ...to.slice(i)].join('/');
}

/**
 * 正文里安全的链接写法。
 *
 * 空格和圆括号会把 `](…)` 这个语法直接撑破（`![](我的 图(1).png)` 解析不出来），
 * 所以只对这几个字符做百分号编码——中文原样留着，那是给人看的，
 * 而读取侧本来就 `decodeURIComponent`。
 */
export function encodeHref(rel: string): string {
  return rel.replace(/[ ()<>]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

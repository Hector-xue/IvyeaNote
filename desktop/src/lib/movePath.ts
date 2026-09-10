/**
 * 侧栏拖拽移动（v0.7.5 E1）的路径计算。
 *
 * 抽成纯函数的理由：移动是**破坏性操作**——算错落点就是把用户的笔记搬丢。
 * 这里把「合法性判定 + 重名消解 + 目录整体搬迁」全部做成可单测的纯逻辑，
 * App 层只负责按结果做 read/write/remove 三步 IO。
 *
 * 同步语义：移动在协议层表达为「新路径 upsert + 旧路径 delete」，
 * 与 v0.4.0 的标题跟随改名一致，多端自然收敛。
 */

export interface MoveOp {
  from: string;
  to: string;
}

function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

function parentDir(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/** 目标目录归一化：去掉首尾斜杠，空串代表库根 */
export function normalizeDir(dir: string): string {
  return dir.replace(/^\/+|\/+$/g, '');
}

/**
 * 在落点目录里给名字找一个不冲突的写法：a.md → a-2.md → a-3.md
 *
 * `isTaken` 由调用方给：文件比对完整路径即可；**目录不能这么比**——
 * 目录本身不是 allPaths 里的条目（列表里只有它下面的文件），
 * 直接查 `日记/AI` 永远查不中，会静默把两个目录合并。
 */
function uniqueIn(name: string, dir: string, isTaken: (fullPath: string) => boolean): string {
  const full = (n: string) => (dir ? `${dir}/${n}` : n);
  if (!isTaken(full(name))) return name;
  const m = name.match(/^(.*?)(\.[^./]+)?$/);
  const stem = m?.[1] ?? name;
  const ext = m?.[2] ?? '';
  for (let i = 2; i < 1000; i++) {
    const cand = `${stem}-${i}${ext}`;
    if (!isTaken(full(cand))) return cand;
  }
  return `${stem}-${Date.now()}${ext}`;
}

/**
 * 计算一次拖拽移动要执行的全部搬迁。
 *
 * @param src      被拖动的路径（文件完整路径，或目录路径）
 * @param destDir  落点目录（'' = 库根）
 * @param allPaths 库内**全部**已知路径（含 .md / .pdf / .keep 等），用于重名消解
 * @param isDir    src 是否是目录
 * @returns 搬迁列表；`null` 表示这次拖拽非法或无意义（原地拖、拖进自己或自己的子目录）
 */
export function planMove(
  src: string,
  destDir: string,
  allPaths: readonly string[],
  isDir: boolean
): MoveOp[] | null {
  const dest = normalizeDir(destDir);
  const from = normalizeDir(src);
  if (!from) return null;

  if (isDir) {
    // 拖进自己 / 自己的子目录：非法，否则会把目录搬进自身造成无限嵌套
    if (dest === from || dest.startsWith(`${from}/`)) return null;
  }
  // 原地拖（落点就是当前所在目录）：无意义
  if (parentDir(from) === dest) return null;

  const taken = new Set(allPaths);

  if (!isDir) {
    const name = uniqueIn(baseName(from), dest, (p) => taken.has(p));
    const to = dest ? `${dest}/${name}` : name;
    return to === from ? null : [{ from, to }];
  }

  // 目录：整体搬迁，内部相对结构保持不变。
  // 目录被占用的判据是「有任何文件在它下面」，不是「它自己在列表里」。
  const dirTaken = (p: string) => allPaths.some((q) => q === p || q.startsWith(`${p}/`));
  const dirName = uniqueIn(baseName(from), dest, dirTaken);
  const newRoot = dest ? `${dest}/${dirName}` : dirName;
  const prefix = `${from}/`;
  const ops = allPaths
    .filter((p) => p.startsWith(prefix))
    .map((p) => ({ from: p, to: `${newRoot}/${p.slice(prefix.length)}` }));
  return ops.length > 0 ? ops : null;
}

/**
 * 移动后重算「当前打开的路径」。
 * 被移动的文件如果正开着，标签页和编辑区必须跟着换路径，否则会指向一个已不存在的文件。
 */
export function remapPath(path: string | null, ops: readonly MoveOp[]): string | null {
  if (!path) return path;
  const hit = ops.find((o) => o.from === path);
  return hit ? hit.to : path;
}

/**
 * 把一批移动反过来（v0.8.7 E1 撤销用）。
 *
 * 顺序也要倒过来：批次里可能存在「先搬 A 再搬 B」这种先后依赖，
 * 撤销时必须后进先出，否则中间态会撞名。
 */
export function invertMoveOps(
  ops: readonly { from: string; to: string }[]
): { from: string; to: string }[] {
  return [...ops].reverse().map((o) => ({ from: o.to, to: o.from }));
}

/**
 * 文件夹重命名的结果。**失败必须说得出是哪一种**——
 * 这个仓库栽过的跟头是「静默 catch 掉，用户只看到点了没反应」，
 * 所以这里不返回 `null` 了事，而是把原因带出去让调用方照着说人话。
 */
export type RenameDirPlan =
  | { ok: true; dir: string; ops: MoveOp[] }
  /** 名字空 / 只剩非法字符 */
  | { ok: false; reason: 'invalid' }
  /** 改了个寂寞（新名等于旧名） */
  | { ok: false; reason: 'same' }
  /** 同一层已经有同名文件夹或同名文件了 */
  | { ok: false; reason: 'taken' };

/**
 * 计算一次「文件夹重命名」要执行的全部搬迁。
 *
 * 重命名 = **同一个父目录里换个名字**的移动，所以复用移动那套语义（新路径 upsert
 * + 旧路径 delete），多端同步自然收敛。与 `planMove` 的关键差别有两处：
 * - 落点是自己的父目录，`planMove` 会把它判成"原地拖"直接拒掉；
 * - 撞名**不自动加序号**。拖拽是个模糊动作，`日记-2` 是合理的兜底；而重命名是
 *   用户明确打进去的名字，悄悄改成别的等于没听他说话——直接告诉他重名。
 *
 * 空文件夹靠 `.keep` 占位，它也在 allPaths 里，所以空目录一样能改名。
 */
export function planRenameDir(
  dir: string,
  newNameRaw: string,
  allPaths: readonly string[]
): RenameDirPlan {
  const from = normalizeDir(dir);
  // 名字里不允许出现路径分隔符：那是"移动"，不是"改名"
  const name = newNameRaw.trim().replace(/\\/g, '/').replaceAll('/', '').trim();
  if (!from || !name || name === '.' || name === '..') return { ok: false, reason: 'invalid' };
  const parent = parentDir(from);
  const to = parent ? `${parent}/${name}` : name;
  if (to === from) return { ok: false, reason: 'same' };
  // 目录被占用的判据是「有任何文件在它下面」——目录本身不是 allPaths 里的条目
  if (allPaths.some((p) => p === to || p.startsWith(`${to}/`))) return { ok: false, reason: 'taken' };
  const prefix = `${from}/`;
  const ops = allPaths
    .filter((p) => p.startsWith(prefix))
    .map((p) => ({ from: p, to: `${to}/${p.slice(prefix.length)}` }));
  return { ok: true, dir: to, ops };
}

/**
 * 文件夹改名后重算「折叠状态」里的那些目录路径。
 *
 * 折叠状态是按目录路径存的：不跟着改名走，改完的文件夹会突然自己展开，
 * 而那个已经不存在的旧路径会永远留在 localStorage 里。
 */
export function remapDirKeys(dirs: Iterable<string>, from: string, to: string): string[] {
  const prefix = `${from}/`;
  return [...dirs].map((d) => (d === from ? to : d.startsWith(prefix) ? `${to}/${d.slice(prefix.length)}` : d));
}

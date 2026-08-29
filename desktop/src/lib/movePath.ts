/**
 * 侧栏拖拽移动（v0.8.0 E1）的路径计算。
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

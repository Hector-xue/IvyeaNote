// 3-way 文本合并（diff3 算法）：共同祖先(base) + 本地(ours) + 服务端(theirs)。
// 原理：分别计算 base→ours、base→theirs 的行级 diff，得到「替换了 base 哪段区间」的
// hunk 列表；按 base 位置游走——只有一方改动的区间直接采纳，双方都改的区间内容相同
// 则取其一、不同则冲突。冲突时返回 null，由上层生成 <name>.conflict-<ts>.md。

export interface MergeResult {
  merged: string | null; // null = 有不可自动解决的冲突
  ours: string;
  theirs: string;
  base: string;
}

type Op = '=' | '-' | '+';

interface DiffOp {
  op: Op;
  lines: string[];
}

/** LCS 行级 diff（O(n*m)，个人笔记规模足够） */
export function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const dp = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] =
        a[i] === b[j] ? dp[at(i + 1, j + 1)] + 1 : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  const push = (op: Op, line: string) => {
    const last = ops[ops.length - 1];
    if (last && last.op === op) last.lines.push(line);
    else ops.push({ op, lines: [line] });
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push('=', a[i]);
      i++;
      j++;
    } else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) {
      push('-', a[i]);
      i++;
    } else {
      push('+', b[j]);
      j++;
    }
  }
  while (i < n) push('-', a[i++]);
  while (j < m) push('+', b[j++]);
  return ops;
}

/** 一个改动块：把 base[start,end) 替换为 lines */
interface Hunk {
  start: number;
  end: number;
  lines: string[];
}

/** 把 diff 结果折叠成 base 区间上的 hunk 列表（区间互不重叠、间隔≥1行） */
function hunksOf(base: string[], to: string[]): Hunk[] {
  const ops = diffLines(base, to);
  const hunks: Hunk[] = [];
  let bi = 0;
  let i = 0;
  while (i < ops.length) {
    if (ops[i].op === '=') {
      bi += ops[i].lines.length;
      i++;
      continue;
    }
    let del = 0;
    const ins: string[] = [];
    while (i < ops.length && ops[i].op !== '=') {
      if (ops[i].op === '-') del += ops[i].lines.length;
      else ins.push(...ops[i].lines);
      i++;
    }
    hunks.push({ start: bi, end: bi + del, lines: ins });
    bi += del;
  }
  return hunks;
}

export function merge3(base: string, ours: string, theirs: string): MergeResult {
  // 平凡情况快速通道
  if (ours === theirs) return { merged: ours, ours, theirs, base };
  if (ours === base) return { merged: theirs, ours, theirs, base };
  if (theirs === base) return { merged: ours, ours, theirs, base };

  const B = base.split('\n');
  const ho = hunksOf(B, ours.split('\n'));
  const ht = hunksOf(B, theirs.split('\n'));

  const out: string[] = [];
  let conflict = false;
  let bi = 0; // 已输出的 base 行游标
  let io = 0;
  let it = 0;

  while (io < ho.length || it < ht.length) {
    const oStart = io < ho.length ? ho[io].start : Number.POSITIVE_INFINITY;
    const tStart = it < ht.length ? ht[it].start : Number.POSITIVE_INFINITY;
    const start = Math.min(oStart, tStart);
    if (!Number.isFinite(start)) break;

    // 输出改动起点之前的未改动 base 行
    while (bi < start) out.push(B[bi++]);

    // 收集与当前区域重叠/相接的所有 hunk（区间端点相接视为同一区域）
    let end = start;
    let oLines: string[] | null = null;
    let tLines: string[] | null = null;
    let grew = true;
    while (grew) {
      grew = false;
      if (io < ho.length && ho[io].start <= end) {
        oLines = oLines ? [...oLines, ...ho[io].lines] : ho[io].lines.slice();
        end = Math.max(end, ho[io].end);
        io++;
        grew = true;
      }
      if (it < ht.length && ht[it].start <= end) {
        tLines = tLines ? [...tLines, ...ht[it].lines] : ht[it].lines.slice();
        end = Math.max(end, ht[it].end);
        it++;
        grew = true;
      }
    }

    if (oLines && tLines) {
      if (oLines.join('\n') === tLines.join('\n')) {
        out.push(...oLines); // 两端做了相同修改
      } else {
        conflict = true; // 同一区域两边改得不一样
        break;
      }
    } else if (oLines) {
      out.push(...oLines);
    } else if (tLines) {
      out.push(...tLines);
    }
    bi = end;
  }

  if (!conflict) {
    // 收尾：剩余未改动的 base 行
    while (bi < B.length) out.push(B[bi++]);
  }

  return { merged: conflict ? null : out.join('\n'), ours, theirs, base };
}

/** 冲突副本内容：三方全文 + 说明头，人工处理后删除本文件 */
export function conflictCopy(name: string, r: MergeResult, ts: string): string {
  return [
    `# ⚠️ 冲突副本：${name}`,
    `# 生成时间：${ts}`,
    `# 本文件由自动合并失败产生。请对比下方三个版本，保留正确内容后删除本文件。`,
    ``,
    `<!-- ===== 本地版本（ours）===== -->`,
    '```markdown',
    r.ours,
    '```',
    ``,
    `<!-- ===== 服务端版本（theirs）===== -->`,
    '```markdown',
    r.theirs,
    '```',
    ``,
    `<!-- ===== 共同祖先（base）===== -->`,
    '```markdown',
    r.base,
    '```',
    ``,
  ].join('\n');
}

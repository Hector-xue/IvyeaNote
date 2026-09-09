/**
 * 按行的最小差异（v0.11.18）。
 *
 * AI 的结果要先给人看"改了哪儿"再决定用不用，所以需要 diff。这里不引任何库：
 * 一个标准的 LCS 动态规划就够——待比的是一段选中的文字，不是整个仓库。
 *
 * 行数保护：超过 400 行就退化成"整段替换"两行（原文 / 结果）。
 * O(n·m) 在几千行上会卡住界面，而那种规模本来也不该一次交给模型改。
 */

export interface DiffRow {
  kind: 'same' | 'add' | 'del';
  text: string;
}

const MAX_LINES = 400;

export function diffLines(before: string, after: string): DiffRow[] {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [
      { kind: 'del', text: `（原文 ${a.length} 行，太长不逐行比对）` },
      { kind: 'add', text: `（结果 ${b.length} 行，切到「结果」页看全文）` },
    ];
  }

  // LCS 长度表
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'del', text: a[i] });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j] });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++] });
  while (j < b.length) out.push({ kind: 'add', text: b[j++] });
  return out;
}

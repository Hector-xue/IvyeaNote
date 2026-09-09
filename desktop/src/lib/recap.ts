/**
 * 「今天 / 这周写了什么」的取材（v0.11.20）。
 *
 * 日记这件事的真实阻力不是没有入口，是**回忆**：晚上坐下来写日记，
 * 想不起来白天到底动了哪几篇、改了什么。这些事实机器全知道——每篇 `.md` 的 mtime
 * 就在那儿。所以这一层做的事是：把「这段时间里动过的笔记」按新到旧摆好，
 * 每篇截一段开头，交给上层拼成一句"今天你在这几篇上做了这些事"。
 *
 * 三条边界：
 * - **日记本身要排除**：不然今天的日记会被拿去总结今天的日记，越滚越长；
 * - **有上限**：篇数与总字数都封顶，一次请求的成本必须是可预期的；
 * - **纯函数**：时间从外面传进来（`now`），不然这层永远测不了。
 */

export interface RecapEntry {
  path: string;
  mtime: number;
  content: string;
}

export interface RecapOptions {
  /** 只看这个时刻之后动过的（毫秒） */
  since: number;
  maxDocs?: number;
  maxCharsPerDoc?: number;
  maxTotalChars?: number;
  /** 日记所在目录，这些不进材料 */
  dailyDir?: string;
}

export interface RecapPiece {
  path: string;
  text: string;
}

const DEFAULTS = {
  maxDocs: 12,
  maxCharsPerDoc: 700,
  maxTotalChars: 6000,
  dailyDir: '日记/',
};

/** 今天零点（本地时区）。"今天"是按人的作息算的，不是按 24 小时前算的 */
export function startOfDay(now = new Date()): number {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return d.getTime();
}

/** 最近 7 天的起点（含今天） */
export function startOfWeek(now = new Date()): number {
  return startOfDay(now) - 6 * 24 * 3600 * 1000;
}

/** 截一段开头，尽量断在换行处；顺手把 frontmatter 去掉（它不是"写了什么"） */
function head(content: string, budget: number): string {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(\r?\n)?/, '').trim();
  if (body.length <= budget) return body;
  const cut = body.slice(0, budget);
  const nl = cut.lastIndexOf('\n');
  return (nl > budget * 0.5 ? cut.slice(0, nl) : cut) + '…';
}

export function pickRecent(entries: readonly RecapEntry[], options: RecapOptions): RecapPiece[] {
  const opts = { ...DEFAULTS, ...options };
  const recent = entries
    .filter((e) => e.mtime >= opts.since)
    .filter((e) => !e.path.startsWith(opts.dailyDir))
    .filter((e) => e.content.trim().length > 0)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, opts.maxDocs);

  const out: RecapPiece[] = [];
  let total = 0;
  for (const e of recent) {
    const budget = Math.min(opts.maxCharsPerDoc, opts.maxTotalChars - total);
    if (budget < 120) break;
    const text = head(e.content, budget);
    if (!text) continue;
    out.push({ path: e.path, text });
    total += text.length;
  }
  return out;
}

/** 拼成给模型看的材料：每篇一段，带路径 */
export function buildRecapSource(pieces: readonly RecapPiece[]): string {
  return pieces.map((p) => `【${p.path}】\n${p.text}`).join('\n\n---\n\n');
}

/**
 * 时间怎么念给人听（v0.11.24，文件历史面板用）。
 *
 * 历史列表里一屏几十个时间，`2026-09-11 10:51:37` 这种全量写法逐条读起来眼睛要
 * 来回对齐；人真正关心的是"多久以前"：刚才 / 今天几点 / 哪天几点。
 */
export function fmtWhen(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const diff = now - ms;
  if (diff >= 0 && diff < 60_000) return '刚才';
  if (diff >= 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const n = new Date(now);
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  if (sameDay) return `今天 ${hm}`;
  const y = new Date(now - 86_400_000);
  const yesterday = d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate();
  if (yesterday) return `昨天 ${hm}`;
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === n.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}年${md} ${hm}`;
}

/** 完整时间，给 title/hover 用 */
export function fmtFull(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 字节数 → 人话 */
export function fmtSize(n: number | undefined): string {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

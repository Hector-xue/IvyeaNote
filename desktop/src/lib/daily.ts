/**
 * v0.7.1 F5：模板 + Daily Notes。
 * - 模板目录固定 `Templates/`（首次使用自动创建并附示例）
 * - Daily Notes：日记/YYYY-MM-DD.md，已存在则直接打开；可选套用模板
 */

export function todayPath(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `日记/${y}-${m}-${d}.md`;
}

/** 模板内容占位替换：{{date}} {{time}} {{title}} */
export function renderTemplate(tpl: string, title: string, now = new Date()): string {
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return tpl.replaceAll('{{date}}', date).replaceAll('{{time}}', time).replaceAll('{{title}}', title);
}

/** 日记初始内容（无模板时） */
export function dailyContent(now = new Date()): string {
  return renderTemplate(`# {{date}}\n\n## 待办\n- [ ] \n\n## 记录\n\n`, todayPath(now), now);
}

/** 找模板目录下的模板列表（从全部文件里过滤） */
export function templateFiles(files: string[]): string[] {
  return files.filter((f) => /^Templates\//.test(f) && /\.(md|markdown)$/i.test(f));
}

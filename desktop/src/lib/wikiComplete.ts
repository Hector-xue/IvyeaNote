/**
 * v0.7.1 F6：编辑器内 [[ 双链自动补全。
 * 输入 [[ 后弹出全库笔记名候选（按标题），选中插入 [[标题]]。
 * titles：全部笔记 path -> 标题（由 App 传入）。
 */
import { type CompletionContext, type CompletionResult, type Completion } from '@codemirror/autocomplete';

export function wikiCompletion(
  getTitles: () => { path: string; title: string }[]
): (ctx: CompletionContext) => Promise<CompletionResult | null> {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    // 匹配光标前的 [[xxx（不含闭合 ]]
    const before = ctx.matchBefore(/\[\[([^\]\n]*)$/);
    if (!before) return null;
    const typed = before.text.slice(2).toLowerCase();

    const options: Completion[] = getTitles()
      .filter((t) => t.title.toLowerCase().includes(typed))
      .slice(0, 20)
      .map((t) => ({
        label: t.title,
        type: 'text',
        detail: t.path,
        apply: (view, _c, from, to) => {
          const insert = `[[${t.title}]]`;
          view.dispatch({
            changes: { from: from - 2, to, insert },
            selection: { anchor: from - 2 + insert.length },
          });
        },
      }));
    if (options.length === 0) return null;
    return {
      from: before.from + 2,
      options,
      validFor: /^[^\]\n]*$/,
    };
  };
}

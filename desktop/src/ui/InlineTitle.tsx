/**
 * 内联标题（v0.10.1）。
 *
 * Obsidian 的做法：**文件名就是标题**。打开一篇笔记，正文上方显示的是文件名，
 * 直接在那儿改，改完文件就跟着改名——正文里不需要再写一遍 `# 标题`。
 *
 * 我们此前是反过来的：新建笔记会往正文塞一行 `# untitled`，靠 `titleSync` 从
 * H1 反推文件名。副作用有两个：
 *   1. 标题在**标签栏和正文里各出现一次**；
 *   2. 那行 H1 是正文的一部分，光标落上去就会露出 `#` 号。
 *
 * 现在改成 Obsidian 的模型。`titleSync`（正文首个 H1 → 文件名）保留不动——
 * 从 Obsidian 之外导入、正文里本来就写着 H1 的笔记仍然照常工作。
 */
import { useEffect, useRef, useState } from 'react';

interface Props {
  /** 库内相对路径；null = 没打开笔记 */
  path: string | null;
  onRename(path: string, nextName: string): void;
}

/** 路径 → 显示用标题（去目录、去扩展名） */
export function titleOf(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.(md|markdown)$/i, '');
}

export function InlineTitle({ path, onRename }: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const title = path ? titleOf(path) : '';

  // 换笔记时丢掉未提交的草稿，否则会把上一篇的标题带过来
  useEffect(() => setDraft(null), [path]);

  // 用 textarea 是为了长标题能自动折行（input 只会横向滚动，中文标题很容易超宽）
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft, title]);

  if (!path) return null;
  const value = draft ?? title;

  const commit = () => {
    const next = (draft ?? '').trim();
    setDraft(null);
    if (draft === null || next === '' || next === title) return;
    onRename(path, next);
  };

  return (
    <textarea
      ref={ref}
      className="inline-title"
      value={value}
      rows={1}
      spellCheck={false}
      aria-label="笔记标题（改这里就是改文件名）"
      onChange={(e) => setDraft(e.target.value.replace(/\n/g, ''))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
          // 回车后把焦点交给正文，符合「填完标题就开始写」的直觉
          document.querySelector<HTMLElement>('.cm-content')?.focus();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setDraft(null);
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
    />
  );
}

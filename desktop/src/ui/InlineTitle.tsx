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
import { extractH1, sanitizeTitle } from '../lib/titleSync';

interface Props {
  /** 库内相对路径；null = 没打开笔记 */
  path: string | null;
  /**
   * 正文。用来判断"这篇的第一行是不是已经把同一个标题写过一遍了"。
   *
   * v0.11.11：用户反馈「文件本来就是这个名字，还非要再命名一次，然后就显示了两个名字」。
   * 现象是内联标题（文件名）和正文首个 H1 一起显示，而两者说的是同一件事——
   * 尤其是标题里带 `/` 这类文件名非法字符时，两行还长得不完全一样
   * （`AI 高效智能 / 单端…` vs 清洗后的 `AI 高效智能 单端…`），看起来就是"两个名字"。
   *
   * 判定按**清洗后**比较：只有清洗后仍不相同，两行才真的携带不同信息，才都显示。
   */
  doc?: string | null;
  onRename(path: string, nextName: string): void;
}

/** 路径 → 显示用标题（去目录、去扩展名） */
export function titleOf(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.(md|markdown)$/i, '');
}

/**
 * 正文首个 H1 是不是"同一个标题"。
 *
 * 用 `sanitizeTitle` 做归一：文件名里不能有 `/ : *` 这些字符，H1 里可以，
 * 所以直接比字符串永远不相等——那正是用户看到"两个名字"的成因。
 */
export function isSameTitle(fileTitle: string, doc: string | null): boolean {
  if (!doc) return false;
  const h1 = extractH1(doc);
  if (!h1) return false;
  return sanitizeTitle(h1).toLowerCase() === sanitizeTitle(fileTitle).toLowerCase();
}

export function InlineTitle({ path, doc, onRename }: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  /*
   * v0.11.15：**草稿要有一份 ref**，否则回车会提交两次。
   *
   * 回车时我们 `commit()` 之后把焦点交给正文——焦点一走就触发 `onBlur`，
   * 而这一拍 React 还没重渲染，blur 里的 `commit` 闭包看到的仍是**旧的 draft**，
   * 于是第二次用**已经不存在的旧路径**再改一次名。用户看到的就是
   * 「已重命名：untitled → 测试」和「重命名失败：… untitled.md … 系统找不到
   * 指定的文件」同时弹出来（2026-09-09 反馈）。
   * ref 是同步的：第一次提交就把它清空，blur 那次直接返回。
   */
  const draftRef = useRef<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const title = path ? titleOf(path) : '';
  const duplicated = isSameTitle(title, doc ?? null);

  // 换笔记时丢掉未提交的草稿，否则会把上一篇的标题带过来
  useEffect(() => {
    draftRef.current = null;
    setDraft(null);
  }, [path]);

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
    const cur = draftRef.current;
    draftRef.current = null;
    setDraft(null);
    if (cur === null) return; // 已经提交过了（回车之后紧跟的那次 blur）
    const next = cur.trim();
    if (next === '' || next === title) return;
    onRename(path, next);
  };

  /*
   * 正文里已经写着同一个标题了，就不再顶一行。
   * 但**正在改**（有草稿）时要保留，否则输入到一半会整块消失。
   */
  if (duplicated && draft === null) return null;

  return (
    <textarea
      ref={ref}
      className="inline-title"
      value={value}
      rows={1}
      spellCheck={false}
      aria-label="笔记标题（改这里就是改文件名）"
      onChange={(e) => {
        const v = e.target.value.replace(/\n/g, '');
        draftRef.current = v;
        setDraft(v);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
          // 回车后把焦点交给正文，符合「填完标题就开始写」的直觉
          document.querySelector<HTMLElement>('.cm-content')?.focus();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          draftRef.current = null;
          setDraft(null);
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
    />
  );
}

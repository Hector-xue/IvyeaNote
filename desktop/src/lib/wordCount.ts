/**
 * v0.5.0 U4：字数统计（对标 Obsidian 底部状态栏）。
 *
 * v0.11.11 按**真实文档实测**重写口径。用户报「同一篇文档 Obsidian 的词数比这边多很多」，
 * 拿他那篇 34KB 的笔记逐项比对（Obsidian 报 6,158 词 / 25,251 字符）：
 *
 * | 口径 | 旧实现 | Obsidian | 现在 |
 * |---|---|---|---|
 * | 字符 | 15,448（**去掉空白、剔掉代码块**） | 25,251 | 25,251 ✅ 完全一致 |
 * | 词 | 5,503（剔掉代码块） | 6,158 | 6,157（差 1） |
 *
 * 三条结论都来自那次比对，不是猜的：
 * 1. **字符 = 原文长度**，空白、换行、Markdown 语法、frontmatter 全算；
 * 2. **代码块也要算**（旧实现整段剔掉，这是差得最多的一项）；
 * 3. **数字里的小数点/千分位不断词**：`18.06` 是一个词，不是两个。
 *
 * 中文按字计数、英文按词计数这两条与原来一致。剩下那 1 个词的偏差没再追——
 * 再往下就是 Obsidian 内部的分词细节了，不值得为它把规则写得没人看得懂。
 */

/** CJK 字符数 */
function cjkCount(text: string): number {
  return (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
}

/**
 * 非中文词数。
 *
 * `[.,]\d+` 那一节是「数字里的点号不断词」：`18.06` / `1,000` 各算一个词。
 * 少了它，一篇带版本号、章节号的笔记会凭空多出几十个词。
 */
function latinWordCount(text: string): number {
  const stripped = text.replace(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ');
  const words = stripped.match(/[A-Za-z0-9_'\-]+(?:[.,][0-9]+)*/g) ?? [];
  return words.length;
}

export interface WordStats {
  /** 词数（中文单字=1词 + 英文单词） */
  words: number;
  /** 字符数（原文长度，含空白与 Markdown 语法——与 Obsidian 同口径） */
  characters: number;
}

export function countWords(md: string): WordStats {
  return { words: cjkCount(md) + latinWordCount(md), characters: md.length };
}

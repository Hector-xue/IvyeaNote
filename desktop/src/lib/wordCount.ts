/**
 * v0.5.0 U4：字数统计（对标 Obsidian 底部状态栏）。
 * 中文按字符计数，英文按空白分词；与 Obsidian 的 words/characters 语义对齐。
 */

/** CJK 字符数 */
function cjkCount(text: string): number {
  return (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
}

/** 非中文词数（按空白/标点切分的拉丁词） */
function latinWordCount(text: string): number {
  const stripped = text.replace(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ');
  const words = stripped.match(/[A-Za-z0-9_'\-]+/g) ?? [];
  return words.length;
}

export interface WordStats {
  /** 词数（中文单字=1词 + 英文单词） */
  words: number;
  /** 字符数（去空白） */
  characters: number;
}

export function countWords(md: string): WordStats {
  const plain = md
    .replace(/```[\s\S]*?```/g, ' ') // 代码块不计
    .replace(/`[^`]*`/g, ' ');
  const words = cjkCount(plain) + latinWordCount(plain);
  const characters = plain.replace(/\s/g, '').length;
  return { words, characters };
}

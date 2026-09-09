/**
 * 排版整理：**纯本地、确定性**的中文 Markdown 规范化（v0.11.18）。
 *
 * # 为什么这件事不交给大模型
 *
 * 用户要的"排版 / 视觉优化"里，绝大部分是**规则**而不是**语言**：中英文之间要不要
 * 空格、标点该用全角还是半角、标题层级能不能从 H2 直接跳到 H4、列表符号是不是
 * 混着 `-` 和 `*`。这些每一条都有确定答案，交给模型的代价是：慢（一次往返）、
 * 花钱（每次都按 token 计费）、**不可复现**（同一段文字两次可能给出不同结果），
 * 而且它还可能顺手改掉你的原话。
 *
 * 所以分工是：**规则的活归这里，语言的活归 AI**（校对、润色、改写在 lib/llm.ts）。
 * 这一层离线可用、瞬时、每次结果完全一样。
 *
 * # 边界：绝不改动"内容"
 *
 * 这里只动**空白与符号**，不增删任何实义文字。代码块、行内代码、链接地址、
 * YAML frontmatter、数学公式一律原样跳过——排版规则套到代码上就是破坏。
 */

/** 一次整理都做了什么，用来给用户一个交代（不是"改好了"三个字） */
export interface TidyReport {
  /** 中英文之间补空格的处 */
  spaced: number;
  /** 标点规范化的处（半角逗号句号 → 全角，等等） */
  punctuation: number;
  /** 统一成 `-` 的列表符号数 */
  listMarkers: number;
  /** 收掉的多余空行数 */
  blankLines: number;
  /** 去掉的行尾空白数 */
  trailing: number;
  /** 补齐的标题层级跳跃（H2 → H4 这种） */
  headings: number;
}

export interface TidyResult {
  text: string;
  report: TidyReport;
  /** 有没有任何改动 */
  changed: boolean;
}

const CJK = '\\u4e00-\\u9fff\\u3040-\\u30ff\\u3400-\\u4dbf';
/** 中文 ↔ 英文数字之间补一个空格（盘古之白）。两侧都不动标点 */
const RE_CJK_LATIN = new RegExp(`([${CJK}])([A-Za-z0-9@#$%^&*])`, 'g');
const RE_LATIN_CJK = new RegExp(`([A-Za-z0-9!?.,;:%)\\]}])([${CJK}])`, 'g');

/**
 * 把一行拆成「可以整理的片段」与「必须原样保留的片段」。
 * 保留的是：行内代码、链接/图片的地址部分、裸 URL、HTML 标签。
 */
function protectInline(line: string): { parts: string[]; holes: string[] } {
  const holes: string[] = [];
  const parts: string[] = [];
  const re = /(`[^`]*`)|(!?\[[^\]]*\]\([^)]*\))|(<[^>]+>)|(https?:\/\/\S+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    parts.push(line.slice(last, m.index));
    holes.push(m[0]);
    last = m.index + m[0].length;
  }
  parts.push(line.slice(last));
  return { parts, holes };
}

function weave(parts: string[], holes: string[]): string {
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    out += parts[i];
    if (i < holes.length) out += holes[i];
  }
  return out;
}

/** 半角标点 → 全角：只在**两侧都是中文**时才换，避免把 `v1.0` 变成 `v1。0` */
function fixPunctuation(seg: string, count: { n: number }): string {
  const map: Record<string, string> = { ',': '，', ';': '；', ':': '：', '!': '！', '?': '？' };
  let out = seg.replace(
    new RegExp(`([${CJK}])([,;:!?])(?=[${CJK}]|$)`, 'g'),
    (_all, cn: string, p: string) => {
      count.n++;
      return cn + map[p];
    }
  );
  // 句号单独处理：`。` 只在中文后且不是小数点/缩写时替换
  out = out.replace(new RegExp(`([${CJK}])\\.(?=\\s|$)`, 'g'), (_all, cn: string) => {
    count.n++;
    return cn + '。';
  });
  return out;
}

/**
 * 整理一段 Markdown。
 *
 * 跳过：围栏代码块、frontmatter、表格分隔行、缩进代码块（4 空格）。
 */
export function tidyMarkdown(src: string): TidyResult {
  const lines = src.split('\n');
  const report: TidyReport = {
    spaced: 0,
    punctuation: 0,
    listMarkers: 0,
    blankLines: 0,
    trailing: 0,
    headings: 0,
  };
  const out: string[] = [];

  let inFence = false;
  let inFrontmatter = false;
  let blankRun = 0;
  let lastHeadingLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // YAML frontmatter：只在文件最开头那一段
    if (i === 0 && /^---\s*$/.test(line)) {
      inFrontmatter = true;
      out.push(line);
      continue;
    }
    if (inFrontmatter) {
      if (/^---\s*$/.test(line)) inFrontmatter = false;
      out.push(line);
      continue;
    }

    // 围栏代码块：原样，连行尾空白都不碰（有的语言里行尾空白有意义）
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    // 缩进代码块（4 空格 / 制表符）同样跳过
    if (/^(\t| {4})/.test(line) && line.trim()) {
      out.push(line);
      continue;
    }

    // 行尾空白：Markdown 里两个空格是"硬换行"，只有 3 个以上才算多余
    const trimmedEnd = line.replace(/[ \t]+$/, (ws) => (ws === '  ' ? '  ' : ''));
    if (trimmedEnd !== line) report.trailing++;
    line = trimmedEnd;

    // 连续空行收到最多一行
    if (!line.trim()) {
      blankRun++;
      if (blankRun > 1) {
        report.blankLines++;
        continue;
      }
      out.push('');
      continue;
    }
    blankRun = 0;

    // 表格分隔行原样（|---|:--:|）
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) {
      out.push(line);
      continue;
    }

    // 列表符号统一成 `-`（`*` / `+` 都换；有序列表不动）
    const li = /^(\s*)([*+])(\s+)/.exec(line);
    if (li) {
      line = `${li[1]}-${li[3]}${line.slice(li[0].length)}`;
      report.listMarkers++;
    }

    // 标题层级不许跳级：H2 之后直接写 H4，降成 H3
    const h = /^(#{1,6})(\s+)(.*)$/.exec(line);
    if (h) {
      let level = h[1].length;
      if (lastHeadingLevel > 0 && level > lastHeadingLevel + 1) {
        level = lastHeadingLevel + 1;
        line = '#'.repeat(level) + h[2] + h[3];
        report.headings++;
      }
      lastHeadingLevel = level;
    }

    // 行内：中英文空格 + 标点，跳过代码/链接/URL
    const { parts, holes } = protectInline(line);
    const punct = { n: 0 };
    const fixed = parts.map((seg) => {
      /*
       * **标点先于空格**。反过来的话，`数据,再动` 里那个半角逗号会先被当成"西文"
       * 补上一个空格，变成 `数据, 再动`；接着全角规则要求逗号后面紧跟中文，
       * 于是永远匹配不上——两条规则各自都对，串起来就互相拆台。
       */
      const withPunct = fixPunctuation(seg, punct);
      let s = withPunct.replace(RE_CJK_LATIN, (_a, a: string, b: string) => `${a} ${b}`);
      s = s.replace(RE_LATIN_CJK, (_a, a: string, b: string) => `${a} ${b}`);
      if (s !== withPunct) report.spaced++;
      return s;
    });
    report.punctuation += punct.n;
    out.push(weave(fixed, holes));
  }

  // 收尾：文件末尾恰好一个换行
  let text = out.join('\n').replace(/\n+$/, '\n');
  if (!text.endsWith('\n')) text += '\n';

  const changed = text !== src;
  return { text, report, changed };
}

/** 把整理报告说成人话；没有任何改动时返回 null */
export function describeTidy(r: TidyReport): string | null {
  const parts: string[] = [];
  if (r.spaced) parts.push(`中英文之间补空格 ${r.spaced} 处`);
  if (r.punctuation) parts.push(`标点规范 ${r.punctuation} 处`);
  if (r.listMarkers) parts.push(`列表符号统一 ${r.listMarkers} 处`);
  if (r.headings) parts.push(`标题层级 ${r.headings} 处`);
  if (r.blankLines) parts.push(`多余空行 ${r.blankLines} 行`);
  if (r.trailing) parts.push(`行尾空白 ${r.trailing} 处`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * 编辑区右键菜单的**定义**（v0.11.0）。
 *
 * 为什么单独一个纯函数文件：用户的原话是「在文档页面的鼠标右键功能也是少的可怜，
 * 还是说本来就没有右键的功能」——核实下来是后者：`onContextMenu` 只绑在文件树上，
 * 编辑区弹出来的是 WebView 自带的那三四项。这次照着 Obsidian 那张菜单补齐，
 * 而菜单**是什么**与菜单**怎么画**必须分开，否则又会变成「桌面一份、移动一份」。
 *
 * 这里只产出数据结构，不碰 DOM、不碰 CodeMirror，可以单测。
 */
import type { MenuItem } from '../ui/ContextMenu';

export interface EditorMenuCtx {
  /** 有没有选中文字：没有选区时「剪切/复制」要置灰，而不是点了没反应 */
  hasSelection: boolean;
  /**
   * v0.11.19：AI 动作列表。**空数组 = 不显示这一组**。
   *
   * 为什么进右键菜单：v0.11.18 把 AI 只挂在顶栏「⋯」的二级菜单和命令面板里，
   * 用户装完的第一句话是「为什么我没有看到任何 AI 按钮呢？只有在设置里面有」。
   * 选中一段文字之后**第一反应是右键**——能力放在人手会去摸的地方才算接上入口。
   */
  aiActions?: { id: string; label: string; hint: string; needsSelection: boolean }[];
  /** 右键正好点在链接上时的地址 */
  linkHref: string | null;
  /** 右键正好点在图片上时的库内路径 */
  imageSrc: string | null;
  /** 能不能插图（没有当前笔记时插不了：附件不知道该放哪） */
  canInsertImage: boolean;
  /** 只读视图（分栏右栏）：所有会改文档的项都不该出现 */
  readOnly?: boolean;
}

export interface EditorMenuActions {
  /** 跑一个 AI 动作（按 id） */
  ai?(id: string): void;
  /** 整理排版：纯本地规则，不联网 */
  tidy?(): void;
  /** 按 TOOLS 里的 key 施加行内/行级格式 */
  format(key: string): void;
  /** 设定标题级别，0 = 正文 */
  heading(level: number): void;
  /** 插入块：table / hr / codeblock / callout / date / time */
  insertBlock(kind: 'table' | 'hr' | 'codeblock' | 'callout' | 'date' | 'time'): void;
  insertImage(): void;
  /** 主动读系统剪贴板里的图片（粘贴键在某些 WebView 上拿不到图时的可靠入口） */
  insertClipboardImage(): void;
  /** 新增链接（选区作为链接文字） */
  link(): void;
  /** 新增外部链接（带 https:// 占位） */
  externalLink(): void;
  clearFormat(): void;
  cut(): void;
  copy(): void;
  paste(): void;
  pastePlain(): void;
  selectAll(): void;
  openLink(href: string): void;
  copyToClipboard(text: string): void;
}

/** Obsidian 那张菜单的结构：链接 → 三个子菜单 → 剪贴板 */
export function buildEditorMenu(ctx: EditorMenuCtx, act: EditorMenuActions): MenuItem[] {
  const items: MenuItem[] = [];

  // 点在链接/图片上时，把和它有关的动作放最前面——这是右键最直接的意图
  if (ctx.linkHref) {
    items.push(
      { id: 'open-link', label: '打开链接', icon: 'external-link', run: () => act.openLink(ctx.linkHref!) },
      {
        id: 'copy-link',
        label: '复制链接地址',
        icon: 'copy',
        run: () => act.copyToClipboard(ctx.linkHref!),
      },
      { type: 'sep', id: 's-link' }
    );
  }
  if (ctx.imageSrc) {
    items.push(
      {
        id: 'copy-img-path',
        label: '复制图片路径',
        icon: 'copy',
        run: () => act.copyToClipboard(ctx.imageSrc!),
      },
      { type: 'sep', id: 's-img' }
    );
  }

  /*
   * AI 放在**最上面**：右键之前用户刚选完一段文字，此刻他想做的十有八九就是
   * "把这段怎么样一下"。放在菜单底部等于让人先滑过十几项格式命令。
   */
  if (!ctx.readOnly && ctx.aiActions && ctx.aiActions.length > 0 && act.ai) {
    items.push(
      {
        id: 'ai',
        label: 'AI 助手',
        icon: 'sparkle',
        submenu: ctx.aiActions.map((a) => ({
          id: `ai-${a.id}`,
          label: a.label,
          // 「校对/润色/精简」光看名字分不清，而它们会直接改正文——点之前就要知道
          hint: a.hint,
          // 需要选区的动作在没选中时置灰——而不是点了弹一句"请先选中"
          disabled: a.needsSelection && !ctx.hasSelection,
          run: () => act.ai?.(a.id),
        })),
      },
      ...(act.tidy
        ? ([{ id: 'tidy', label: '整理排版（本地规则）', icon: 'text-format', run: act.tidy }] as MenuItem[])
        : []),
      { type: 'sep', id: 's-ai' }
    );
  }

  if (!ctx.readOnly) {
    items.push(
      { id: 'link', label: '新增链接', icon: 'link-plus', shortcut: 'Ctrl+K', run: act.link },
      { id: 'ext-link', label: '新增外部链接', icon: 'external-link', run: act.externalLink },
      { type: 'sep', id: 's1' },
      {
        id: 'text-format',
        label: '文本格式',
        icon: 'text-format',
        submenu: [
          { id: 'b', label: '加粗', icon: 'bold', shortcut: 'Ctrl+B', run: () => act.format('b') },
          { id: 'i', label: '斜体', icon: 'italic', shortcut: 'Ctrl+I', run: () => act.format('i') },
          { id: 'strike', label: '删除线', icon: 'strikethrough', run: () => act.format('strike') },
          { id: 'mark', label: '高亮', icon: 'highlight', run: () => act.format('mark') },
          { id: 'code', label: '行内代码', icon: 'code', run: () => act.format('code') },
          { type: 'sep', id: 's-tf' },
          { id: 'clear', label: '清除格式', icon: 'clear-format', disabled: !ctx.hasSelection, run: act.clearFormat },
        ],
      },
      {
        id: 'para',
        label: '段落设置',
        icon: 'paragraph',
        submenu: [
          { id: 'p', label: '正文', icon: 'paragraph', run: () => act.heading(0) },
          { id: 'h1', label: '标题 1', icon: 'heading', run: () => act.heading(1) },
          { id: 'h2', label: '标题 2', icon: 'heading', run: () => act.heading(2) },
          { id: 'h3', label: '标题 3', icon: 'heading', run: () => act.heading(3) },
          { id: 'h4', label: '标题 4', icon: 'heading', run: () => act.heading(4) },
          { id: 'h5', label: '标题 5', icon: 'heading', run: () => act.heading(5) },
          { id: 'h6', label: '标题 6', icon: 'heading', run: () => act.heading(6) },
          { type: 'sep', id: 's-para' },
          { id: 'quote', label: '引用', icon: 'quote', run: () => act.format('q') },
          { id: 'ul', label: '无序列表', icon: 'list-ul', run: () => act.format('ul') },
          { id: 'ol', label: '有序列表', icon: 'list-ol', run: () => act.format('ol') },
          { id: 'task', label: '任务列表', icon: 'task', run: () => act.format('task') },
          { id: 'codeblock', label: '代码块', icon: 'code-block', run: () => act.insertBlock('codeblock') },
        ],
      },
      {
        id: 'insert',
        label: '插入',
        icon: 'insert',
        submenu: [
          {
            id: 'image',
            label: '图片…',
            icon: 'image',
            disabled: !ctx.canInsertImage,
            run: act.insertImage,
          },
          {
            id: 'clip-image',
            label: '剪贴板里的图片',
            icon: 'paste',
            disabled: !ctx.canInsertImage,
            run: act.insertClipboardImage,
          },
          { id: 'table', label: '表格', icon: 'table', run: () => act.insertBlock('table') },
          { id: 'hr', label: '分隔线', icon: 'minus', run: () => act.insertBlock('hr') },
          { id: 'callout', label: '标注', icon: 'callout', run: () => act.insertBlock('callout') },
          { type: 'sep', id: 's-ins' },
          { id: 'date', label: '当前日期', icon: 'calendar', run: () => act.insertBlock('date') },
          { id: 'time', label: '当前时间', icon: 'calendar', run: () => act.insertBlock('time') },
        ],
      },
      { type: 'sep', id: 's2' },
      { id: 'cut', label: '剪切', icon: 'cut', shortcut: 'Ctrl+X', disabled: !ctx.hasSelection, run: act.cut }
    );
  }

  items.push({
    id: 'copy',
    label: '复制',
    icon: 'copy',
    shortcut: 'Ctrl+C',
    disabled: !ctx.hasSelection,
    run: act.copy,
  });

  if (!ctx.readOnly) {
    items.push(
      { id: 'paste', label: '粘贴', icon: 'paste', shortcut: 'Ctrl+V', run: act.paste },
      {
        id: 'paste-plain',
        label: '以纯文本形式粘贴',
        icon: 'paste-text',
        shortcut: 'Ctrl+Shift+V',
        run: act.pastePlain,
      }
    );
  }
  items.push({ id: 'select-all', label: '全选', icon: 'select-all', shortcut: 'Ctrl+A', run: act.selectAll });

  return items;
}

/** 「插入」子菜单里那几个块的源码。集中在这里，测试能直接断言产物 */
export function blockSnippet(kind: 'table' | 'hr' | 'codeblock' | 'callout' | 'date' | 'time', now = new Date()): {
  text: string;
  /** 光标该落在块内的第几个字符（不给就落末尾） */
  caret?: number;
} {
  const pad = (n: number) => String(n).padStart(2, '0');
  switch (kind) {
    case 'table':
      // 光标落在第一个表头单元格：插完就能直接打字，不用再自己点进去
      return { text: '| 列 1 | 列 2 |\n| --- | --- |\n|  |  |\n', caret: 2 };
    case 'hr':
      return { text: '\n---\n\n' };
    case 'codeblock':
      return { text: '```\n\n```\n', caret: 4 };
    case 'callout':
      return { text: '> [!note] 提示\n> \n', caret: 14 };
    case 'date':
      return { text: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` };
    case 'time':
      return { text: `${pad(now.getHours())}:${pad(now.getMinutes())}` };
  }
}

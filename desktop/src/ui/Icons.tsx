/**
 * v0.5.0 U5/U6：线性 SVG 图标（wireframe 风，stroke-width 1.6，fill none）。
 * 替代 emoji 图标，对齐 Obsidian 的克制视觉。
 */
export type IconName =
  | 'graph' | 'tag' | 'folder' | 'trash' | 'moon' | 'sun' | 'file' | 'search'
  | 'bold' | 'italic' | 'heading' | 'list-ul' | 'list-ol' | 'task' | 'quote'
  | 'code' | 'link' | 'image' | 'eye' | 'edit' | 'settings'
  // v0.10.0 移动端重做新增。移动端此前整套用 emoji（☰ ↻ ✏️ 🗑 📂 🏷），
  // 与桌面 ribbon 的线性图标是两套语言——「没有 Obsidian 影子」有一半出在这里。
  | 'sidebar' | 'more-vertical' | 'plus' | 'chevron-left' | 'chevron-right'
  | 'chevron-down' | 'book' | 'sort' | 'collapse' | 'folder-plus' | 'file-plus'
  | 'backlink' | 'outline' | 'sync' | 'close' | 'move' | 'check' | 'text-format'
  // v0.10.6：同步失败的状态图标。此前状态栏只有 sync 一个图标，成功失败长一个样
  | 'alert'
  // v0.11.0 编辑区右键菜单（对标 Obsidian 那张菜单：每项左侧一个图标）
  | 'link-plus' | 'external-link' | 'paragraph' | 'insert' | 'cut' | 'copy'
  | 'paste' | 'paste-text' | 'select-all' | 'table' | 'minus' | 'calendar'
  | 'strikethrough' | 'highlight' | 'clear-format' | 'code-block' | 'callout'
  // v0.11.0 窗口自绘按钮 + 图谱工具
  | 'win-min' | 'win-max' | 'win-restore' | 'win-close'
  | 'zoom-in' | 'zoom-out' | 'focus' | 'filter' | 'page-left' | 'page-right';

const PATHS: Record<IconName, React.ReactNode> = {
  // ---- v0.10.0 移动端 ----
  /** 侧栏开关：Obsidian 移动端左上角那个「圆角矩形 + 左侧竖条」 */
  sidebar: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M9 4v16" />
    </>
  ),
  'more-vertical': (
    <>
      <circle cx="12" cy="5" r="1.2" fill="currentColor" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
      <circle cx="12" cy="19" r="1.2" fill="currentColor" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  /** 同步失败：三角警示 */
  alert: (
    <>
      <path d="M12 3.5 1.8 20.5h20.4L12 3.5z" />
      <path d="M12 10v4.5" />
      <circle cx="12" cy="17.4" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  'chevron-left': <path d="M15 6l-6 6 6 6" />,
  'chevron-right': <path d="M9 6l6 6-6 6" />,
  'chevron-down': <path d="M6 9l6 6 6-6" />,
  /** 阅读视图 */
  /** 阅读视图：一本摊开的书。原来画成两个并排矩形，和 sidebar 图标撞脸 */
  book: (
    <>
      <path d="M12 6.5C10.5 5.2 8.6 4.5 6 4.5H3v13h3c2.6 0 4.5.7 6 2 1.5-1.3 3.4-2 6-2h3v-13h-3c-2.6 0-4.5.7-6 2z" />
      <path d="M12 6.5v13" />
    </>
  ),
  sort: <path d="M4 6h13M4 12h9M4 18h5M17 14l3 3 3-3M20 17V8" />,
  collapse: (
    <>
      <path d="M7 9l5-5 5 5M7 15l5 5 5-5" />
    </>
  ),
  'folder-plus': (
    <>
      <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z" />
      <path d="M12 11v5M9.5 13.5h5" />
    </>
  ),
  /*
   * v0.11.0：`file` / `file-plus` 重画。
   *
   * 旧的两条路径画在 x6–18 / y2–22 的网格上，而这套图标里**其它每一个**
   * （folder / folder-plus / sort / collapse …）都落在 x3–21 / y4–20——
   * 于是「新建笔记」在侧栏那一行图标里又窄又高、还顶着上下边，
   * 用户的原话是「新建笔记的图标也和其它图标不搭配」。
   * 现在统一到 x5–19 / y3–21：与文件夹同一视觉重量，圆角也对齐（r=2）。
   */
  'file-plus': (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v3a2 2 0 0 0 2 2h3" />
      <path d="M12 12.5v5M9.5 15h5" />
    </>
  ),
  /** 反向链接：一条指回来的链 */
  backlink: (
    <>
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </>
  ),
  outline: <path d="M4 6h16M8 12h12M12 18h8" />,
  sync: <path d="M20 11a8 8 0 0 0-13.7-5.7L4 7.5M4 4v3.5H7.5M4 13a8 8 0 0 0 13.7 5.7L20 16.5M20 20v-3.5h-3.5" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  move: (
    <>
      <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z" />
      <path d="M9 14h6M13 11l3 3-3 3" />
    </>
  ),
  check: <path d="M5 13l4 4L19 7" />,
  'text-format': (
    <>
      <path d="M3 18L8 6l5 12M4.8 14h6.4" />
      <path d="M20 18v-5.5a2.5 2.5 0 0 0-4.6-1.3M15.5 15.8c0 1.3 1 2.2 2.3 2.2 1.2 0 2.2-.8 2.2-2v-1.2h-2.3c-1.3 0-2.2.7-2.2 1.6z" />
    </>
  ),

  // ---- v0.11.0 编辑区右键菜单 ----
  /** 新增链接：一条链 + 加号（对标 Obsidian 菜单第一项） */
  'link-plus': (
    <>
      <path d="M10 13.5a4.2 4.2 0 0 0 6.3.4l2.2-2.2a4.2 4.2 0 0 0-5.9-5.9l-1.3 1.2" />
      <path d="M13.4 10.5a4.2 4.2 0 0 0-6.3-.4l-2.2 2.2a4.2 4.2 0 0 0 4 7" />
      <path d="M17.5 16.5v5M15 19h5" />
    </>
  ),
  'external-link': (
    <>
      <path d="M13 4h7v7" />
      <path d="M20 4l-9 9" />
      <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
    </>
  ),
  /** 段落设置：一个 ¶ 的骨架 */
  paragraph: <path d="M13 4v16M17 4v16M13 4H9.5a4.5 4.5 0 0 0 0 9H13M19 4h-6" />,
  insert: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2.5" />
      <path d="M12 8.5v7M8.5 12h7" />
    </>
  ),
  cut: (
    <>
      <circle cx="6.5" cy="17.5" r="2.5" />
      <circle cx="17.5" cy="17.5" r="2.5" />
      <path d="M8.3 15.7 18 4M15.7 15.7 6 4" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" />
    </>
  ),
  paste: (
    <>
      <path d="M9 4H6.5A1.5 1.5 0 0 0 5 5.5v14A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-14A1.5 1.5 0 0 0 17.5 4H15" />
      <rect x="9" y="2.5" width="6" height="3.5" rx="1.2" />
    </>
  ),
  /** 以纯文本形式粘贴：剪贴板里只剩几条横线（没有格式） */
  'paste-text': (
    <>
      <path d="M9 4H6.5A1.5 1.5 0 0 0 5 5.5v14A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-14A1.5 1.5 0 0 0 17.5 4H15" />
      <rect x="9" y="2.5" width="6" height="3.5" rx="1.2" />
      <path d="M8.5 11h7M8.5 14.5h7M8.5 18h4" />
    </>
  ),
  'select-all': (
    <>
      <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
      <path d="M8.5 12h7M8.5 9h7M8.5 15h4" />
    </>
  ),
  table: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M9.5 4.5v15" />
    </>
  ),
  minus: <path d="M4 12h16" />,
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M8 3.5v3M16 3.5v3" />
    </>
  ),
  strikethrough: <path d="M4 12h16M16.5 7.5C15.6 6 14 5.2 12 5.2c-2.6 0-4.3 1.3-4.3 3 0 1.3.9 2.2 2.6 2.8M7.5 16.4c.8 1.6 2.4 2.4 4.5 2.4 2.8 0 4.5-1.3 4.5-3.2 0-1.1-.5-1.9-1.5-2.5" />,
  highlight: (
    <>
      <path d="M14.5 3.5 20 9l-8.2 8.2H6.3v-5.5z" />
      <path d="M4 21h16" />
    </>
  ),
  'clear-format': (
    <>
      <path d="M5 6V4.5h11V6M10.5 4.5V16M8 19.5h5" />
      <path d="M15.5 15.5 21 21M21 15.5 15.5 21" />
    </>
  ),
  'code-block': (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M9.5 9.5 7 12l2.5 2.5M14.5 9.5 17 12l-2.5 2.5" />
    </>
  ),
  callout: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <path d="M7 5v14" />
      <path d="M11.5 9v3.5M11.5 15.4h.01" />
    </>
  ),
  // ---- v0.11.0 窗口自绘按钮。故意画成 Windows 的细线字形，不用本套 1.6 描边 ----
  'win-min': <path d="M5 12h14" />,
  'win-max': <rect x="5.5" y="5.5" width="13" height="13" rx="1" />,
  'win-restore': (
    <>
      <rect x="4.5" y="7.5" width="11" height="11" rx="1" />
      <path d="M8 7.5V6a1.5 1.5 0 0 1 1.5-1.5H18A1.5 1.5 0 0 1 19.5 6v8.5A1.5 1.5 0 0 1 18 16h-1.5" />
    </>
  ),
  'win-close': <path d="M5.5 5.5l13 13M18.5 5.5l-13 13" />,
  // ---- v0.11.0 图谱工具条 ----
  'zoom-in': (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l5 5M10.5 8v5M8 10.5h5" />
    </>
  ),
  'zoom-out': (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l5 5M8 10.5h5" />
    </>
  ),
  focus: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
    </>
  ),
  filter: <path d="M4 5h16l-6.2 7.4v5.4l-3.6 2v-7.4z" />,
  'page-left': <path d="M14 6l-6 6 6 6" />,
  'page-right': <path d="M10 6l6 6-6 6" />,

  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 8.9 19a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 5 8.9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.6 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>
  ),
  folder: <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z" />,
  trash: (
    <>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
    </>
  ),
  moon: <path d="M20 13A8 8 0 0 1 11 4a8 8 0 1 0 9 9z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v3a2 2 0 0 0 2 2h3" />
    </>
  ),
  search: (
    <>
      <circle cx="10" cy="10" r="6" />
      <path d="M15 15l5 5" />
    </>
  ),
  bold: <path d="M7 4h6a3.5 3.5 0 0 1 0 7H7zm0 7h7a3.5 3.5 0 0 1 0 7H7z" />,
  italic: <path d="M10 4h8M6 20h8M14 4l-4 16" />,
  heading: <path d="M6 4v16M18 4v16M6 12h12" />,
  'list-ul': <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />,
  'list-ol': <path d="M9 6h12M9 12h12M9 18h12M4 5l1.5-1v5M3.8 15.5a1.3 1.3 0 0 1 2.4.6c0 .9-2.4 1.6-2.4 2.9h2.7" />,
  task: <path d="M9 6h11M9 12h11M9 18h11M3 6l1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17" />,
  quote: <path d="M5 11h4v6H5zM15 11h4v6h-4zM9 11c0-3 1-5 3-6M19 11c0-3 1-5 3-6" transform="scale(0.85) translate(1 1)" />,
  code: <path d="M8 6l-5 6 5 6M16 6l5 6-5 6" />,
  link: <path d="M9 15l6-6M8 12l-2.5 2.5a3.5 3.5 0 0 0 5 5L13 17M11 7l2.5-2.5a3.5 3.5 0 0 1 5 5L16 12" />,
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M3 17l5-4 4 3 4-3 5 4" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  edit: <path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3zM14 6l3 3" />,
  tag: (
    <>
      <path d="M3 3h8l10 10-8 8L3 11V3z" />
      <circle cx="8" cy="8" r="1.5" />
    </>
  ),
  graph: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
      <path d="M8 7l7.5 1M7.5 8l3.5 8M16.5 10l-3.5 6" />
    </>
  ),
};

export function RibbonIcon({
  name,
  size = 18,
  /** 描边粗细。窗口按钮那三个字形要更细（Windows 自己就是 1px 细线），其余保持 1.6 */
  stroke = 1.6,
}: {
  name: IconName;
  size?: number;
  stroke?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

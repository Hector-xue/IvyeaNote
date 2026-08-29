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
  | 'backlink' | 'outline' | 'sync' | 'close' | 'move' | 'check' | 'text-format';

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
  'file-plus': (
    <>
      <path d="M6 2h8l4 4v16H6V2zm8 0v4h4" />
      <path d="M12 11v6M9 14h6" />
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
  file: <path d="M6 2h8l4 4v16H6V2zm8 0v4h4" />,
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

export function RibbonIcon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

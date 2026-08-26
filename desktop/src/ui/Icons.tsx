/**
 * v0.5.0 U5/U6：线性 SVG 图标（wireframe 风，stroke-width 1.6，fill none）。
 * 替代 emoji 图标，对齐 Obsidian 的克制视觉。
 */
export type IconName = 'graph' | 'tag' | 'folder' | 'trash' | 'moon' | 'sun' | 'file' | 'search' | 'bold' | 'italic' | 'heading' | 'list-ul' | 'list-ol' | 'task' | 'quote' | 'code' | 'link' | 'image' | 'eye' | 'edit';

const PATHS: Record<IconName, React.ReactNode> = {
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

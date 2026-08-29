/**
 * 多层文件树（对标 Obsidian 文件管理器）。
 * - 递归嵌套树，文件夹优先排序
 * - 文件名隐藏 .md 后缀
 * - hover 浮现操作按钮
 * - 文件夹折叠（持久化到 localStorage）
 * - v0.8.0 E1：**拖拽移动**——拖文件/文件夹到目标文件夹即移动，拖到空白处移到库根；
 *   悬停折叠文件夹 600ms 自动展开（Obsidian 的 spring-loaded 行为）
 */
import { useMemo, useRef, useState } from 'react';

export interface TreeNode {
  name: string;
  path: string; // 目录路径（文件夹）或文件完整路径
  type: 'dir' | 'file';
  children?: TreeNode[];
}

/** 由扁平路径列表构建嵌套树 */
export function buildFileTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', type: 'dir', children: [] };
  for (const p of [...paths].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))) {
    const parts = p.split('/');
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join('/');
      let next = cur.children!.find((c) => c.type === (isLast ? 'file' : 'dir') && c.path === path);
      if (!next) {
        next = { name: parts[i], path, type: isLast ? 'file' : 'dir', children: isLast ? undefined : [] };
        cur.children!.push(next);
      }
      cur = next;
    }
  }
  // 排序：文件夹在前，名称中文序
  const sortNode = (n: TreeNode) => {
    n.children?.sort((a, b) =>
      a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, 'zh-Hans-CN')
    );
    n.children?.forEach(sortNode);
  };
  sortNode(root);
  return root.children ?? [];
}

/** 显示名：文件隐藏 .md/.markdown 后缀 */
export function displayName(name: string, isFile: boolean): string {
  return isFile ? name.replace(/\.(md|markdown)$/i, '') : name;
}

/** 拖拽载荷。用组件内 ref 传递而不是只靠 dataTransfer——后者在 WebView2/安卓
 *  WebView 里对自定义 MIME 的支持不一致，实测会拿到空串。 */
interface DragItem {
  path: string;
  isDir: boolean;
}

interface Props {
  nodes: TreeNode[];
  currentPath: string | null;
  collapsed: Set<string>;
  onToggleDir(dir: string): void;
  onSelectFile(path: string): void;
  onNewNoteIn(folder: string): void;
  onNewFolderIn(folder: string): void;
  onDeleteFile(path: string): void;
  /** v0.8.0 E1：把 src 移动到 destDir（'' = 库根）。未传则整棵树不可拖。 */
  onMovePath?(src: string, destDir: string, isDir: boolean): void;
}

export function FileTree(props: Props) {
  const dragRef = useRef<DragItem | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropDir, setDropDir] = useState<string | null>(null);
  const springTimer = useRef<number | undefined>(undefined);
  const canDrag = !!props.onMovePath;

  const clearSpring = () => {
    window.clearTimeout(springTimer.current);
    springTimer.current = undefined;
  };

  const endDrag = () => {
    clearSpring();
    dragRef.current = null;
    setDragging(null);
    setDropDir(null);
  };

  /** 目标是否合法：不能把目录拖进自己或自己的子目录 */
  const canDropInto = (destDir: string): boolean => {
    const d = dragRef.current;
    if (!d) return false;
    if (d.isDir && (destDir === d.path || destDir.startsWith(`${d.path}/`))) return false;
    // 原地拖：落点就是当前所在目录
    const parent = d.path.includes('/') ? d.path.slice(0, d.path.lastIndexOf('/')) : '';
    return parent !== destDir;
  };

  const startDrag = (e: React.DragEvent, path: string, isDir: boolean) => {
    dragRef.current = { path, isDir };
    setDragging(path);
    // Firefox 必须 setData 才会真正发起拖拽
    e.dataTransfer.setData('text/plain', path);
    e.dataTransfer.effectAllowed = 'move';
  };

  const overDir = (e: React.DragEvent, dir: string, isCollapsed: boolean) => {
    if (!canDrag || !canDropInto(dir)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (dropDir !== dir) {
      setDropDir(dir);
      clearSpring();
      // 悬停自动展开折叠的文件夹，方便拖进深层目录
      if (isCollapsed) {
        springTimer.current = window.setTimeout(() => props.onToggleDir(dir), 600);
      }
    }
  };

  const dropInto = (e: React.DragEvent, dir: string) => {
    if (!canDrag) return;
    e.preventDefault();
    e.stopPropagation();
    const d = dragRef.current;
    if (d && canDropInto(dir)) props.onMovePath!(d.path, dir, d.isDir);
    endDrag();
  };

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const pad = { paddingLeft: `${10 + depth * 16}px` };
    if (node.type === 'dir') {
      const isOpen = !props.collapsed.has(node.path);
      const cls = [
        'ft-dir',
        isOpen ? 'open' : '',
        dropDir === node.path ? 'drop-target' : '',
        dragging === node.path ? 'dragging' : '',
      ]
        .filter(Boolean)
        .join(' ');
      return (
        <div key={node.path} className="ft-node">
          <div
            className={cls}
            style={pad}
            draggable={canDrag}
            onDragStart={(e) => startDrag(e, node.path, true)}
            onDragEnd={endDrag}
            onDragOver={(e) => overDir(e, node.path, !isOpen)}
            onDragLeave={() => {
              if (dropDir === node.path) {
                clearSpring();
                setDropDir(null);
              }
            }}
            onDrop={(e) => dropInto(e, node.path)}
            onClick={() => props.onToggleDir(node.path)}
          >
            <span className="ft-caret">{isOpen ? '▾' : '▸'}</span>
            <span className="ft-dir-name">{node.name}</span>
            <span className="ft-actions">
              <button
                title="在此新建笔记"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onNewNoteIn(node.path);
                }}
              >
                ＋
              </button>
              <button
                title="在此新建子文件夹"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onNewFolderIn(node.path);
                }}
              >
                ⊞
              </button>
            </span>
          </div>
          {isOpen && node.children?.map((c) => renderNode(c, depth + 1))}
        </div>
      );
    }
    const cls = [
      'ft-file',
      props.currentPath === node.path ? 'active' : '',
      dragging === node.path ? 'dragging' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <div
        key={node.path}
        className={cls}
        style={pad}
        draggable={canDrag}
        onDragStart={(e) => startDrag(e, node.path, false)}
        onDragEnd={endDrag}
        onClick={() => props.onSelectFile(node.path)}
      >
        <span className="ft-file-name" title={node.path}>
          {displayName(node.name, true)}
        </span>
        <span className="ft-actions">
          <button
            title="删除"
            onClick={(e) => {
              e.stopPropagation();
              props.onDeleteFile(node.path);
            }}
          >
            ✕
          </button>
        </span>
      </div>
    );
  };

  // 外层同时是「库根」落区：拖到任何文件夹之外都等于移到根目录
  return (
    <div
      className={`ft-root ${dropDir === '' ? 'drop-target' : ''}`}
      data-testid="ft-root"
      onDragOver={(e) => overDir(e, '', false)}
      onDragLeave={() => {
        if (dropDir === '') setDropDir(null);
      }}
      onDrop={(e) => dropInto(e, '')}
    >
      {props.nodes.map((n) => renderNode(n, 0))}
    </div>
  );
}

/** 折叠状态持久化 helper */
export function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem('ivnote.collapsed') ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}
export function saveCollapsed(s: Set<string>): void {
  localStorage.setItem('ivnote.collapsed', JSON.stringify([...s]));
}

/** 测试/外部构建树入口 */
export function useFileTree(paths: string[]): TreeNode[] {
  return useMemo(() => buildFileTree(paths), [paths]);
}

/**
 * v0.5.0 U3：多层文件树（对标 Obsidian 文件管理器）。
 * - 递归嵌套树，替代旧的一层目录分组
 * - 文件名隐藏 .md 后缀
 * - hover 浮现操作按钮（新建/删除）
 * - 文件夹折叠（持久化到 localStorage）
 */
import { useMemo } from 'react';

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

interface Props {
  nodes: TreeNode[];
  currentPath: string | null;
  collapsed: Set<string>;
  onToggleDir(dir: string): void;
  onSelectFile(path: string): void;
  onNewNoteIn(folder: string): void;
  onNewFolderIn(folder: string): void;
  onDeleteFile(path: string): void;
}

export function FileTree(props: Props) {
  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const pad = { paddingLeft: `${10 + depth * 16}px` };
    if (node.type === 'dir') {
      const isOpen = !props.collapsed.has(node.path);
      return (
        <div key={node.path} className="ft-node">
          <div
            className={`ft-dir ${isOpen ? 'open' : ''}`}
            style={pad}
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
    return (
      <div
        key={node.path}
        className={`ft-file ${props.currentPath === node.path ? 'active' : ''}`}
        style={pad}
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

  return <>{props.nodes.map((n) => renderNode(n, 0))}</>;
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

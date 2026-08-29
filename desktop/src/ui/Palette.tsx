/**
 * v0.7.0 F1+F2：万能面板（对标 Obsidian Quick Switcher / Search / Command palette）。
 * - Ctrl+K：全库搜索（正文命中 + 预览行）
 * - Ctrl+O：快速切换（只搜标题，回车打开）
 * - Ctrl+P：命令面板（列出全部注册命令）
 * 一个组件三种模式，键盘上下选择 + 回车执行。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { searchNotes, type SearchDoc, type SearchHit } from '../lib/searchIndex';
import { orderByRecent } from '../lib/recent';

export type PaletteMode = 'search' | 'switcher' | 'commands';

export interface CommandItem {
  id: string;
  label: string;
  run(): void;
}

export interface PaletteProps {
  mode: PaletteMode;
  docs: SearchDoc[];
  /** 最近打开的路径，最近的在前（快速切换器排序用） */
  recent?: string[];
  commands: CommandItem[];
  onOpenNote(path: string): void;
  onClose(): void;
}

/** 标题显示名（隐藏后缀 + 保留目录） */
function titleOf(path: string): string {
  const i = path.lastIndexOf('/');
  const dir = i > 0 ? path.slice(0, i) + ' / ' : '';
  return dir + path.slice(i + 1).replace(/\.(md|markdown)$/i, '');
}

export function Palette(props: PaletteProps) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 模式切换时清空查询
  useEffect(() => {
    setQuery('');
    setSel(0);
  }, [props.mode]);

  const results = useMemo(() => {
    if (props.mode === 'commands') {
      const q = query.toLowerCase();
      return props.commands
        .filter((c) => c.label.toLowerCase().includes(q))
        .map((c) => ({ key: c.id, title: c.label, preview: [] as string[], run: c.run }));
    }
    if (props.mode === 'switcher') {
      const q = query.toLowerCase();
      // v0.7.10 E6：按最近打开排序。此前是文件名字母序——而人找的几乎总是「刚才那几篇」。
      const matched = props.docs.filter((d) => titleOf(d.path).toLowerCase().includes(q));
      return orderByRecent(matched, props.recent ?? [], (d) => d.path)
        .slice(0, 30)
        .map((d) => ({
          key: d.path,
          title: titleOf(d.path),
          preview: (props.recent ?? []).includes(d.path) && !q ? ['最近打开'] : [],
          run: () => props.onOpenNote(d.path),
        }));
    }
    // search：正文搜索
    const hits: SearchHit[] = query.trim()
      ? searchNotes(props.docs, query)
      : props.docs.slice(0, 30).map((d) => ({ path: d.path, score: 0, preview: [] }));
    return hits.map((h) => ({
      key: h.path,
      title: titleOf(h.path),
      preview: h.preview,
      run: () => props.onOpenNote(h.path),
    }));
  }, [props.mode, props.docs, props.commands, props.recent, query]);

  const pick = (i: number) => {
    const r = results[i];
    if (!r) return;
    r.run();
    props.onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(sel);
    } else if (e.key === 'Escape') {
      props.onClose();
    }
  };

  const placeholder =
    props.mode === 'search'
      ? '全库搜索…（支持 "精确短语"、path:目录）'
      : props.mode === 'switcher'
        ? '输入笔记名快速切换…'
        : '输入命令名…';

  return (
    <div className="dlg-mask palette-mask" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="palette-card" role="dialog" aria-modal="true">
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          placeholder={placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
          }}
          onKeyDown={onKeyDown}
        />
        <ul className="palette-list">
          {results.length === 0 && <li className="palette-empty">无结果</li>}
          {results.map((r, i) => (
            <li
              key={r.key}
              className={`palette-item ${i === sel ? 'active' : ''}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => pick(i)}
            >
              <span className="pi-title">{r.title}</span>
              {r.preview.map((p, j) => (
                <span key={j} className="pi-preview">
                  {p}
                </span>
              ))}
            </li>
          ))}
        </ul>
        <div className="palette-foot">↑↓ 选择 · Enter 打开 · Esc 关闭</div>
      </div>
    </div>
  );
}

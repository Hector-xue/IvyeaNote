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
import { fuzzyMatch, splitByRanges, type FuzzyResult } from '../lib/fuzzy';

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
        .map((c) => ({ c, m: fuzzyMatch(c.label, q) }))
        .filter((x): x is { c: CommandItem; m: FuzzyResult } => x.m !== null)
        .sort((a, b) => b.m.score - a.m.score)
        .map(({ c, m }) => ({
          key: c.id,
          title: c.label,
          ranges: m.ranges,
          preview: [] as string[],
          run: c.run,
        }));
    }
    if (props.mode === 'switcher') {
      const q = query.trim();
      /*
       * v0.7.10 E6：按最近打开排序（人找的几乎总是「刚才那几篇」）。
       * v0.8.4 E6：改子串匹配为模糊匹配——想开「亚马逊/广告优化」原来得完整敲出
       * 连续的一段，而人记住的往往是零散几个字。
       *
       * 没输入时仍然完全按最近打开排；一旦输入，模糊分数是主序、最近打开是次序
       * ——否则「最近打开过但匹配很差」的项会压在头上。
       */
      const matched = props.docs
        .map((d) => ({ d, m: fuzzyMatch(titleOf(d.path), q) }))
        .filter((x): x is { d: SearchDoc; m: FuzzyResult } => x.m !== null);
      const byRecent = orderByRecent(matched, props.recent ?? [], (x) => x.d.path);
      const ordered = q === '' ? byRecent : [...byRecent].sort((a, b) => b.m.score - a.m.score);
      return ordered.slice(0, 30).map(({ d, m }) => ({
        key: d.path,
        title: titleOf(d.path),
        ranges: m.ranges,
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
      ranges: [] as readonly [number, number][],
      preview: h.preview.map((p) => p.text),
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
              <span className="pi-title">
                {splitByRanges(r.title, r.ranges).map((seg, k) =>
                  seg.hit ? (
                    <mark key={k} className="pi-hit">
                      {seg.text}
                    </mark>
                  ) : (
                    <span key={k}>{seg.text}</span>
                  )
                )}
              </span>
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

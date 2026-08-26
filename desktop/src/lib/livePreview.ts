/**
 * v0.5.0 U1：Live Preview（对标 Obsidian）。
 * 用 CodeMirror 装饰 API 在编辑态直接渲染 Markdown 样式：
 * - 标题（#~###）→ 大字号粗体；行首标记光标不在时隐藏
 * - **加粗** / *斜体* / `代码` → 对应样式，标记符光标不在其中时隐藏
 * - > 引用 → 左边线 + 灰字
 * - - [ ] / - [x] 任务 → 渲染为可点击复选框（点击切换源码）
 */
import {
  ViewPlugin,
  Decoration,
  WidgetType,
  type DecorationSet,
  type EditorView as IEditorView,
} from '@codemirror/view';
import { EditorSelection, Range, StateEffect } from '@codemirror/state';

export const toggleTaskEffect = StateEffect.define<number>(); // 载荷：任务行内任意 offset

export const livePreviewTheme = {
  '.cm-line': { lineHeight: '1.7' },
  '.cm-live-h1': { fontSize: '1.75em', fontWeight: '700', lineHeight: '1.3', marginTop: '0.4em' },
  '.cm-live-h2': { fontSize: '1.45em', fontWeight: '700', lineHeight: '1.35', marginTop: '0.35em' },
  '.cm-live-h3': { fontSize: '1.2em', fontWeight: '650' },
  '.cm-live-h4, .cm-live-h5, .cm-live-h6': { fontSize: '1.05em', fontWeight: '650' },
  '.cm-live-bold': { fontWeight: '700' },
  '.cm-live-italic': { fontStyle: 'italic' },
  '.cm-live-code': {
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
    fontSize: '0.9em',
    background: 'rgba(127,127,127,0.14)',
    borderRadius: '4px',
    padding: '1px 4px',
  },
  '.cm-live-quote': {
    color: 'var(--muted, #888)',
    borderLeft: '3px solid var(--border, #ccc)',
    paddingLeft: '10px',
    opacity: '0.92',
  },
  '.cm-live-marker': { color: 'transparent', fontSize: '0px' },
  '.cm-task-checkbox': {
    border: '1.5px solid var(--muted, #999)',
    borderRadius: '3px',
    width: '14px',
    height: '14px',
    display: 'inline-block',
    marginRight: '6px',
    cursor: 'pointer',
    verticalAlign: 'middle',
    fontSize: '11px',
    lineHeight: '13px',
    textAlign: 'center',
    userSelect: 'none',
  },
  '.cm-task-checked': { background: 'var(--accent, #4a8)', borderColor: 'var(--accent, #4a8)' },
  '.cm-task-checked-text': { textDecoration: 'line-through', opacity: '0.6' },
};

interface TaskHit {
  boxFrom: number;
  boxTo: number;
  textFrom: number;
  checked: boolean;
}
void (0 as unknown as TaskHit | null);

/** 光标是否在区间附近（附近=区间内或紧贴边缘±1，此时显示源码） */
function cursorNear(sel: EditorSelection, from: number, to: number): boolean {
  return sel.ranges.some((r) => r.to >= from - 1 && r.from <= to + 1);
}

/** 从行文本解析任务语法（支持 -, *, + 列表符），返回源码内绝对 offset */
export function parseTaskLine(
  lineText: string,
  lineFrom: number
): { boxFrom: number; boxTo: number; textFrom: number; checked: boolean } | null {
  const m = lineText.match(/^(\s*)([-*+])\s+\[( |x|X)\]\s*/);
  if (!m) return null;
  const bracketPos = lineText.indexOf('[');
  const boxFrom = lineFrom + bracketPos;
  return {
    boxFrom,
    boxTo: boxFrom + 3,
    textFrom: lineFrom + m[0].length,
    checked: m[3].toLowerCase() === 'x',
  };
}

class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  override eq(other: TaskWidget) {
    return other.checked === this.checked;
  }
  override toDOM() {
    const span = document.createElement('span');
    span.className = `cm-task-checkbox${this.checked ? ' cm-task-checked' : ''}`;
    span.textContent = this.checked ? '✓' : '';
    span.setAttribute('aria-label', this.checked ? '已完成任务' : '未完成任务');
    return span;
  }
  override ignoreEvent() {
    return false;
  }
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;

    constructor(view: IEditorView) {
      this.build(view);
    }

    update(u: any) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        this.build(u.view);
      }
      // 响应复选框点击：切换该行任务状态
      for (const tr of u.transactions) {
        for (const e of tr.effects) {
          if (e.is(toggleTaskEffect)) {
            const line = u.view.state.doc.lineAt(e.value);
            const hit = parseTaskLine(line.text, line.from);
            if (hit) {
              const bracketOffset = line.from + line.text.indexOf('[');
              u.view.dispatch({
                changes: {
                  from: bracketOffset + 1,
                  to: bracketOffset + 2,
                  insert: hit.checked ? ' ' : 'x',
                },
              });
            }
          }
        }
      }
    }

    build(view: IEditorView) {
      const decos: Range<Decoration>[] = [];
      const sel = view.state.selection;
      for (const { from, to } of view.visibleRanges) {
        let pos = from;
        while (pos <= to) {
          const line = view.state.doc.lineAt(pos);
          const t = line.text;

          // ---- 标题 ----
          const h = t.match(/^(#{1,6})\s+(.*)$/);
          if (h) {
            const markTo = line.from + h[1].length + 1;
            decos.push(Decoration.line({ class: `cm-live-h${h[1].length}` }).range(line.from));
            if (!cursorNear(sel, line.from, markTo)) {
              decos.push(Decoration.mark({ class: 'cm-live-marker' }).range(line.from, markTo));
            }
          } else {
            // ---- 引用 ----
            const gm = t.match(/^\s*>\s?/);
            if (gm) {
              decos.push(Decoration.line({ class: 'cm-live-quote' }).range(line.from));
              const markTo = line.from + gm[0].length;
              if (!cursorNear(sel, line.from, markTo)) {
                decos.push(Decoration.mark({ class: 'cm-live-marker' }).range(line.from, markTo));
              }
            }

            // ---- 行内：加粗 / 斜体 / 行内代码 ----
            const inlineRe = /(\*\*([^*]+)\*\*)|(\*([^*\n]+)\*)|(`([^`]+)`)/g;
            let im: RegExpExecArray | null;
            while ((im = inlineRe.exec(t))) {
              const start = line.from + im.index;
              const end = start + im[0].length;
              if (cursorNear(sel, start, end)) continue;
              if (im[1]) {
                decos.push(Decoration.mark({ class: 'cm-live-bold' }).range(start + 2, end - 2));
                decos.push(Decoration.mark({ class: 'cm-live-marker' }).range(start, start + 2));
                decos.push(Decoration.mark({ class: 'cm-live-marker' }).range(end - 2, end));
              } else if (im[3]) {
                decos.push(Decoration.mark({ class: 'cm-live-code' }).range(start + 1, end - 1));
                decos.push(Decoration.mark({ class: 'cm-live-marker' }).range(start, start + 1));
                decos.push(Decoration.mark({ class: 'cm-live-marker' }).range(end - 1, end));
              } else {
                decos.push(Decoration.mark({ class: 'cm-live-italic' }).range(start + 1, end - 1));
                decos.push(Decoration.mark({ class: 'cm-live-marker' }).range(start, start + 1));
                decos.push(Decoration.mark({ class: 'cm-live-marker' }).range(end - 1, end));
              }
            }

            // ---- 任务复选框 ----
            const task = parseTaskLine(t, line.from);
            if (task && !cursorNear(sel, task.boxFrom, task.textFrom)) {
              decos.push(Decoration.replace({ widget: new TaskWidget(task.checked) }).range(task.boxFrom, task.boxTo));
              if (task.checked && task.textFrom < line.to) {
                decos.push(Decoration.mark({ class: 'cm-task-checked-text' }).range(task.textFrom, line.to));
              }
            }
          }
          pos = line.to + 1;
        }
      }
      this.decorations = Decoration.set(decos, true);
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      mousedown(e: MouseEvent, view: any) {
        const target = e.target as HTMLElement;
        if (target.classList?.contains('cm-task-checkbox')) {
          const pos = view.posAtDOM(target);
          view.dispatch({ effects: toggleTaskEffect.of(pos) });
          e.preventDefault();
          return true;
        }
        return false;
      },
    },
  }
);

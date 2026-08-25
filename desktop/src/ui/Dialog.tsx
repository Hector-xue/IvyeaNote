/**
 * 应用内对话框（v0.3.3 新增）：替代 window.prompt / window.confirm。
 *
 * 为什么必须自己画框：WebView2（Windows 版 Tauri 内核）对 window.prompt()
 * 静默返回 null、不弹任何窗口，导致「新建笔记 / 新建笔记库」按钮点了毫无反应。
 * 应用内模态框在所有平台（Win/mac/Linux/Android）行为一致。
 *
 * 用法（App 层）：
 *   const { prompt, confirm, dialogEl } = useDialog();
 *   const name = await prompt({ title: '新建笔记', validate: ... }); // 取消返回 null
 *   const ok = await confirm({ title: '删除笔记', danger: true });   // 取消返回 false
 *   渲染时把 dialogEl 挂到组件树根部。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface PromptOptions {
  title: string;
  /** 标题下方的灰色说明文字 */
  description?: string;
  placeholder?: string;
  initial?: string;
  okText?: string;
  /** 确认前校验：返回错误文案则阻止提交并行内显示；返回 null/空 通过 */
  validate?: (value: string) => string | null;
}

export interface ConfirmOptions {
  title: string;
  description?: string;
  okText?: string;
  cancelText?: string;
  /** 危险操作（如删除）：确认按钮用红色 */
  danger?: boolean;
}

type Active =
  | { kind: 'input'; opts: PromptOptions }
  | { kind: 'confirm'; opts: ConfirmOptions };

/** Esc 关闭：挂 document 监听，避免焦点不在卡片内时失效 */
function useEscClose(onCancel: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);
}

function InputCard({ opts, onDone }: { opts: PromptOptions; onDone: (v: string | null) => void }) {
  const [value, setValue] = useState(opts.initial ?? '');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEscClose(() => onDone(null));

  const submit = () => {
    if (opts.validate) {
      const err = opts.validate(value);
      if (err) {
        setError(err);
        inputRef.current?.focus();
        return;
      }
    }
    onDone(value);
  };

  return (
    <div
      className="dlg-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onDone(null);
      }}
    >
      <div className="dlg-card" role="dialog" aria-modal="true" aria-label={opts.title}>
        <h2 className="dlg-title">{opts.title}</h2>
        {opts.description && <p className="dlg-desc">{opts.description}</p>}
        <input
          ref={inputRef}
          className="dlg-input"
          value={value}
          placeholder={opts.placeholder}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
        {error && <div className="dlg-error">{error}</div>}
        <div className="dlg-actions">
          <button className="btn ghost" onClick={() => onDone(null)}>
            取消
          </button>
          <button className="btn primary" onClick={submit}>
            {opts.okText ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfirmCard({ opts, onDone }: { opts: ConfirmOptions; onDone: (v: boolean) => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // 焦点默认放「取消」：防止误按 Enter 直接执行危险操作
    cancelRef.current?.focus();
  }, []);
  useEscClose(() => onDone(false));

  return (
    <div
      className="dlg-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onDone(false);
      }}
    >
      <div className="dlg-card" role="alertdialog" aria-modal="true" aria-label={opts.title}>
        <h2 className="dlg-title">{opts.title}</h2>
        {opts.description && <p className="dlg-desc">{opts.description}</p>}
        <div className="dlg-actions">
          <button ref={cancelRef} className="btn ghost" onClick={() => onDone(false)}>
            {opts.cancelText ?? '取消'}
          </button>
          <button className={`btn ${opts.danger ? 'danger' : 'primary'}`} onClick={() => onDone(true)}>
            {opts.okText ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 对话框 Hook：返回 Promise 风格的 prompt/confirm，调用方式与原生 API 对齐，
 * 替换成本最小；dialogEl 由消费方挂到组件树（当前有且只有一个对话框）。
 */
export function useDialog() {
  const [active, setActive] = useState<Active | null>(null);
  const resolveRef = useRef<((v: string | boolean | null) => void) | null>(null);
  const seq = useRef(0);
  const [dlgKey, setDlgKey] = useState(0);

  const open = useCallback((next: Active) => {
    seq.current += 1;
    setDlgKey(seq.current); // key 变化强制重建卡片，清空上一轮的输入/错误状态
    setActive(next);
  }, []);

  const promptFn = useCallback(
    (opts: PromptOptions): Promise<string | null> =>
      new Promise((resolve) => {
        resolveRef.current = (v) => resolve(v as string | null);
        open({ kind: 'input', opts });
      }),
    [open]
  );

  const confirmFn = useCallback(
    (opts: ConfirmOptions): Promise<boolean> =>
      new Promise((resolve) => {
        resolveRef.current = (v) => resolve(!!v);
        open({ kind: 'confirm', opts });
      }),
    [open]
  );

  const finish = useCallback((v: string | boolean | null) => {
    const r = resolveRef.current;
    resolveRef.current = null;
    setActive(null);
    r?.(v);
  }, []);

  let dialogEl: React.ReactNode = null;
  if (active) {
    dialogEl =
      active.kind === 'input' ? (
        <InputCard key={dlgKey} opts={active.opts} onDone={(v) => finish(v)} />
      ) : (
        <ConfirmCard key={dlgKey} opts={active.opts} onDone={(v) => finish(v)} />
      );
  }

  return { prompt: promptFn, confirm: confirmFn, dialogEl };
}

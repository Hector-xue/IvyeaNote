/**
 * 设置（v0.7.10 E10）。
 *
 * 此前设置是散的：主题在 ribbon、排序在下拉框、绑定文件夹在侧栏、更新在命令面板。
 * 用户想「改点什么」时得先猜它在哪。这里收拢成一个面板。
 *
 * 两条交互原则：
 * - **改即生效，没有「保存」按钮**。外观类设置的正确反馈是眼前立刻变，
 *   不是按一下保存再看结果；
 * - 每一项都给**当前值**和**默认值**的提示，让人敢动——不敢动的设置等于没有。
 */
import { DEFAULTS, LIMITS, type Appearance, type ReadFont, type ThemeMode } from '../lib/appearance';

interface Props {
  value: Appearance;
  onChange(next: Appearance): void;
  onClose(): void;
  appVersion: string;
  onCheckUpdate(): void;
}

const THEMES: { id: ThemeMode; label: string }[] = [
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
  { id: 'system', label: '跟随系统' },
];

const FONTS: { id: ReadFont; label: string; hint: string }[] = [
  { id: 'sans', label: '无衬线', hint: '界面同款，屏幕上最省力' },
  { id: 'serif', label: '衬线', hint: '长文阅读更从容' },
  { id: 'mono', label: '等宽', hint: '写代码笔记时对齐好看' },
];

export function SettingsView(props: Props) {
  const v = props.value;
  const set = (patch: Partial<Appearance>) => props.onChange({ ...v, ...patch });

  return (
    <div
      className="dlg-mask"
      onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}
    >
      <div className="dlg-card settings-card" role="dialog" aria-label="设置">
        <div className="set-head">
          <h2 className="set-title">设置</h2>
          <button className="icon-btn" title="关闭" onClick={props.onClose}>
            ✕
          </button>
        </div>

        <div className="set-body">
          <section className="set-section">
            <h3 className="set-h">外观</h3>

            <div className="set-row">
              <label className="set-label">主题</label>
              <div className="seg">
                {THEMES.map((t) => (
                  <button
                    key={t.id}
                    className={`seg-btn ${v.theme === t.id ? 'on' : ''}`}
                    onClick={() => set({ theme: t.id })}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="set-row">
              <label className="set-label">正文字体</label>
              <div className="seg">
                {FONTS.map((f) => (
                  <button
                    key={f.id}
                    className={`seg-btn ${v.font === f.id ? 'on' : ''}`}
                    title={f.hint}
                    onClick={() => set({ font: f.id })}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="set-row">
              <label className="set-label" htmlFor="set-fs">
                正文字号
                <span className="set-val">
                  {v.fontSize}px
                  {v.fontSize !== DEFAULTS.fontSize && (
                    <em className="set-def">默认 {DEFAULTS.fontSize}</em>
                  )}
                </span>
              </label>
              <input
                id="set-fs"
                type="range"
                min={LIMITS.fontSize.min}
                max={LIMITS.fontSize.max}
                step={LIMITS.fontSize.step}
                value={v.fontSize}
                onChange={(e) => set({ fontSize: Number(e.target.value) })}
              />
            </div>

            <div className="set-row">
              <label className="set-label" htmlFor="set-measure">
                正文宽度
                <span className="set-val">
                  {v.measure}px
                  {v.measure !== DEFAULTS.measure && (
                    <em className="set-def">默认 {DEFAULTS.measure}</em>
                  )}
                </span>
              </label>
              <input
                id="set-measure"
                type="range"
                min={LIMITS.measure.min}
                max={LIMITS.measure.max}
                step={LIMITS.measure.step}
                value={v.measure}
                onChange={(e) => set({ measure: Number(e.target.value) })}
              />
              <p className="set-hint">编辑与阅读共用同一个宽度，切换视图时文字不会重排。</p>
            </div>

            <div className="set-row">
              <label className="set-label" htmlFor="set-lh">
                行高
                <span className="set-val">
                  {v.lineHeight.toFixed(2)}
                  {v.lineHeight !== DEFAULTS.lineHeight && (
                    <em className="set-def">默认 {DEFAULTS.lineHeight}</em>
                  )}
                </span>
              </label>
              <input
                id="set-lh"
                type="range"
                min={LIMITS.lineHeight.min}
                max={LIMITS.lineHeight.max}
                step={LIMITS.lineHeight.step}
                value={v.lineHeight}
                onChange={(e) => set({ lineHeight: Number(e.target.value) })}
              />
              <p className="set-hint">中文比拉丁需要更松的行距，1.75 是舒适下限。</p>
            </div>

            {/* 实时样张：改上面任何一项，这里立刻跟着变 */}
            <div className="set-preview md-preview">
              <h2>样张</h2>
              <p>
                今天研究了 Agent 的编排方式。核心结论是：让模型自己决定调用顺序，
                比写死流程更稳，前提是工具的返回要足够结构化。
              </p>
            </div>

            <button className="btn ghost set-reset" onClick={() => props.onChange({ ...DEFAULTS })}>
              恢复默认外观
            </button>
          </section>

          <section className="set-section">
            <h3 className="set-h">关于</h3>
            <div className="set-row set-about">
              <span className="set-label">当前版本 v{props.appVersion}</span>
              <button className="btn" onClick={props.onCheckUpdate}>
                检查更新
              </button>
            </div>
            <p className="set-hint">
              笔记始终是你磁盘上的普通 Markdown 文件。卸载本软件后，用任何编辑器都能继续打开。
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

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
import { RibbonIcon } from './Icons';
import { DEFAULTS, LIMITS, type Appearance, type ReadFont, type ThemeMode } from '../lib/appearance';
import { SHORTCUTS, type Prefs } from '../lib/prefs';
import type { AttachMode } from '../lib/attachPath';

interface Props {
  value: Appearance;
  onChange(next: Appearance): void;
  onClose(): void;
  appVersion: string;
  onCheckUpdate(): void;
  /** v0.8.6 E10：行为偏好（编辑器 / 同步分区） */
  prefs: Prefs;
  onPrefsChange(next: Prefs): void;
  /** 同步分区要显示的现状 */
  sync: {
    /** 已登录账号的服务器地址；未登录为 null */
    server: string | null;
    account: string | null;
    syncing: boolean;
    onSyncNow(): void;
    /**
     * v0.10.3：这两个入口以前只存在于命令面板里（Ctrl+P → 「添加设备（配对码）」），
     * 也就是说：不知道有命令面板的人，永远找不到"怎么让手机也同步"。
     */
    onOpenLogin(): void;
    onAddDevice(): void;
    /** 上一次同步的报错。没有它，设置里"已登录 + 立即同步"看上去永远一切正常 */
    lastError?: string | null;
    /** 退出同步。桌面端此前**根本没有这个入口**——MainView 收了 onLogout 却从没渲染过 */
    onLogout(): void;
    /**
     * v0.10.5：内置服务端。null＝这份构建没带（或不是桌面端），此时不显示这一块。
     * 「Windows + 安卓」是主力组合，而它此前要同步得先自己搭服务器——这个开关
     * 就是为了把那一步彻底去掉。
     */
    localServer: {
      running: boolean;
      busy: boolean;
      lanUrl: string | null;
      onToggle(next: boolean): void;
    } | null;
  };
  /**
   * v0.10.2：**存储位置**。此前设置里根本没有这一节，"绑定本地文件夹"藏在
   * 侧栏库名的下拉菜单里，移动端一个入口都没有——于是"笔记到底存在哪、
   * 能不能换个地方"完全没有答案，而这恰恰是本地优先笔记软件最该说清的一件事。
   */
  storage: {
    /** 磁盘绝对路径；null = 应用内部存储（OPFS） */
    path: string | null;
    /** 当前库里的文件数，用于说明"会搬多少东西" */
    fileCount: number;
    /** 这台设备能不能选目录（浏览器版不能） */
    canPick: boolean;
    /** 安卓：系统目录选择要 Android SAF，Tauri 现在还没有——得把话说明白 */
    isAndroid: boolean;
    onPick(): void;
    onUnbind(): void;
  };
  /** v0.9.0 P3：Agent 接入区块（令牌管理），由 App 注入以免这里去碰 SyncClient */
  agentSection?: React.ReactNode;
}

/** 开关行：一句标题 + 一句「关掉会怎样」。说不清后果的开关没人敢动 */
function Toggle(props: {
  label: string;
  hint: string;
  checked: boolean;
  onChange(v: boolean): void;
}) {
  return (
    <div className="set-row set-toggle-row">
      <label className="set-label">
        {props.label}
        <span className="set-hint">{props.hint}</span>
      </label>
      <button
        role="switch"
        aria-checked={props.checked}
        aria-label={props.label}
        className={`set-switch ${props.checked ? 'on' : ''}`}
        onClick={() => props.onChange(!props.checked)}
      >
        <span className="set-switch-dot" />
      </button>
    </div>
  );
}

/**
 * 账号那一行给人看的名字。
 * 内置服务端的账号是本机随机生成的（`me-xxxxxx@ivnote.local`），配对进来的设备
 * 存的是 `paired-user-3`——把这两串原样摆在"已登录"后面，用户只会怀疑自己登错了。
 */
export function accountLabel(email: string, serverUrl: string | null): string {
  let local = false;
  try {
    const h = serverUrl ? new URL(serverUrl).hostname : '';
    local = h === '127.0.0.1' || h === 'localhost' || h === '::1';
  } catch {
    /* 地址坏了就按普通账号处理 */
  }
  if (local && email.endsWith('@ivnote.local')) return '已连到这台电脑上的同步服务';
  if (/^paired-user-\d+$/.test(email)) return '已通过配对码连上';
  return `已登录 ${email}`;
}

/**
 * 附件存放位置。措辞照 Obsidian 的同名设置，因为用户多半是从那边过来的。
 *
 * 每一项都直接给出**正文里会写成什么**——附件设置最容易让人犯迷糊的
 * 恰恰是这一步，而这个应用刚好在这里错过一次（写库根相对、读也库根相对，
 * 两头一起错所以自己看不出来，换 Obsidian 打开就全是断图）。
 */
const ATTACH_MODES: { id: AttachMode; label: string; hint: string }[] = [
  {
    id: 'beside',
    label: '与笔记同一个文件夹',
    hint: '笔记 项目/周报.md 的图片存成 项目/图.png，正文写 ![](图.png)。整个文件夹拷走或发给别人都不会断图',
  },
  {
    id: 'subfolder',
    label: '笔记同级的 Attachments/',
    hint: '笔记 项目/周报.md 的图片存成 项目/Attachments/图.png。图片集中，但仍跟着笔记走',
  },
  {
    id: 'vault',
    label: '库根的 Attachments/',
    hint: '所有图片都堆在库根 Attachments/。整个库一起搬才不会断——单独拷一个子文件夹会丢图',
  },
];

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
  const p = props.prefs;
  const setPref = (patch: Partial<Prefs>) => props.onPrefsChange({ ...p, ...patch });

  /*
   * Esc 由 App 统一处理（见 App 里的「Esc 关最上面那一层」）。
   * 各浮层各挂一个 window 监听的结果是：配对码开在设置之上时按一下 Esc，
   * 两层一起塌掉——而设置里的快捷键表白纸黑字写着「Esc 关闭当前浮层」。
   */

  return (
    <div
      className="dlg-mask"
      onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}
    >
      <div className="dlg-card settings-card" role="dialog" aria-label="设置">
        <div className="set-head">
          <h2 className="set-title">设置</h2>
          <button className="icon-btn" title="关闭" onClick={props.onClose}>
            <RibbonIcon name="close" size={16} />
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
            <h3 className="set-h">编辑器</h3>

            <div className="set-row">
              <label className="set-label">
                打开笔记时
                <span className="set-hint">默认进编辑态；常写完就读的人可以改成阅读</span>
              </label>
              <div className="seg">
                {(['edit', 'read'] as const).map((m) => (
                  <button
                    key={m}
                    className={`seg-btn ${p.defaultView === m ? 'on' : ''}`}
                    onClick={() => setPref({ defaultView: m })}
                  >
                    {m === 'edit' ? '编辑' : '阅读'}
                  </button>
                ))}
              </div>
            </div>

            <Toggle
              label="编辑态实时预览"
              hint="标题字号、加粗、任务框直接在源码上渲染。关掉就是纯 Markdown 源码"
              checked={p.livePreview}
              onChange={(x) => setPref({ livePreview: x })}
            />
            <Toggle
              label="标题跟随文件名"
              hint="正文第一个 # 标题改了，文件名跟着改。关掉后文件名只能手动重命名"
              checked={p.titleSync}
              onChange={(x) => setPref({ titleSync: x })}
            />

            <div className="set-row">
              <label className="set-label">
                插入的图片存到哪
                <span className="set-hint">
                  只影响以后新插入的图片；已经在库里的一张都不动
                </span>
              </label>
              <div className="seg">
                {ATTACH_MODES.map((m) => (
                  <button
                    key={m.id}
                    className={`seg-btn ${p.attachMode === m.id ? 'on' : ''}`}
                    title={m.hint}
                    onClick={() => setPref({ attachMode: m.id })}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <p className="set-hint">
                {ATTACH_MODES.find((m) => m.id === p.attachMode)?.hint}
              </p>
            </div>
          </section>

          <section className="set-section">
            <h3 className="set-h">存储位置</h3>
            <div className="set-row set-about">
              <span className="set-label">
                {props.storage.path ? '磁盘文件夹' : '应用内部存储'}
                <span className="set-hint set-path" title={props.storage.path ?? undefined}>
                  {props.storage.path ??
                    '笔记保存在应用私有空间里。卸载应用会连同笔记一起删除，其它编辑器也打不开。'}
                </span>
              </span>
              {props.storage.canPick ? (
                <button className="btn" onClick={props.storage.onPick}>
                  {props.storage.path ? '换个位置…' : '选择文件夹…'}
                </button>
              ) : (
                <span className="set-hint">此版本无法选择目录</span>
              )}
            </div>
            {props.storage.path ? (
              <>
                <p className="set-hint">
                  笔记就是这个文件夹里的普通 .md 文件，可以直接用别的编辑器打开、用网盘同步、
                  或者随时备份。换位置时会把现有 {props.storage.fileCount} 个文件复制过去。
                </p>
                <div className="set-row set-about">
                  <span className="set-label">
                    改回应用内部存储
                    <span className="set-hint">磁盘上的原文件会保留，不会被删除</span>
                  </span>
                  <button className="btn" onClick={props.storage.onUnbind}>
                    改回内部存储
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="set-hint">
                  ⚠️ 放在内部存储里的笔记，卸载或「清除数据」后<b>无法找回</b>，也没法用别的工具打开。
                </p>
                {/*
                  这三句原来不分平台照单全发：网页版明明已经显示「此版本无法选择目录」，
                  底下却接着教人去点一个根本不存在的「选择文件夹…」。能不能选，
                  决定的是说哪一句话。
                */}
                {!props.storage.canPick ? (
                  <p className="set-hint">
                    网页版只能用浏览器的私有存储，换不了位置。想让笔记落到磁盘上、
                    能用别的编辑器打开，请改用桌面版或手机 App；也可以先开启同步，
                    笔记会流到已经绑好文件夹的那台设备上。
                  </p>
                ) : props.storage.isAndroid ? (
                  <p className="set-hint">
                    点「选择文件夹…」会打开系统的目录选择器。选好之后笔记就存在那个目录里
                    （比如「文档」，或某个网盘的同步目录），<b>卸载应用也不会跟着删</b>，
                    用别的编辑器也能直接打开。
                  </p>
                ) : (
                  <p className="set-hint">选一个磁盘文件夹，笔记就变成随时能备份、能用别的编辑器打开的普通文件。</p>
                )}
              </>
            )}
          </section>

          <section className="set-section">
            <h3 className="set-h">同步</h3>

            {/*
              内置服务端的开关此前**只画在"未登录"那一支里**。而打开它会自动登录，
              于是开关自己把自己藏起来了：局域网地址没了、想关也关不掉，
              「手机怎么连电脑」在开启之后反而无处可查。它是设备级的设施，
              和登没登录无关，应该一直在。
            */}
            {props.sync.localServer && (
              <div className="set-sub">
                <Toggle
                  label="在这台电脑上开启同步"
                  hint="把这台电脑变成你自己的同步服务器，数据只存在本机。手机连同一个 Wi-Fi 就能同步，不需要账号、不需要域名，也不用装任何别的东西"
                  checked={props.sync.localServer.running}
                  onChange={(v) => props.sync.localServer!.onToggle(v)}
                />
                {props.sync.localServer.busy && <p className="set-hint">正在处理…</p>}
                {props.sync.localServer.running &&
                  (props.sync.localServer.lanUrl ? (
                    <>
                      <p className="set-hint">
                        手机上打开 Ivyea Note → 开启同步 → 「找找附近的电脑」即可；
                        找不到时手动填 <b className="set-lan">{props.sync.localServer.lanUrl}</b>。
                      </p>
                      <p className="set-hint">
                        这台电脑关机、退出程序或关掉上面这个开关时，同步都会暂停——手机上的笔记不会丢，只是暂时不流动。
                      </p>
                    </>
                  ) : (
                    <p className="set-hint">
                      没能拿到这台电脑的局域网地址（可能没连 Wi-Fi / 有线网）。接入同一个网络后手机才能找到它。
                    </p>
                  ))}
                {props.sync.localServer.running && props.sync.account && (
                  <div className="set-row set-about">
                    <span className="set-label">
                      让手机连上来
                      <span className="set-hint">生成一个 6 位配对码，手机上填一次就好，不用输地址和密码</span>
                    </span>
                    <button className="btn" onClick={props.sync.onAddDevice}>
                      生成配对码
                    </button>
                  </div>
                )}
              </div>
            )}

            {props.sync.account ? (
              <>
                <div className="set-row set-about">
                  <span className="set-label">
                    {accountLabel(props.sync.account, props.sync.server)}
                    <span className="set-hint">{props.sync.server ?? ''}</span>
                  </span>
                  <button className="btn" disabled={props.sync.syncing} onClick={props.sync.onSyncNow}>
                    {props.sync.syncing ? '同步中…' : '立即同步'}
                  </button>
                </div>
                {/* 上一次同步失败就得说出来。只画一个"立即同步"按钮，等于把失败藏起来 */}
                {props.sync.lastError && (
                  <p className="set-hint set-err">上次同步没成功：{props.sync.lastError}</p>
                )}
                <Toggle
                  label="自动同步"
                  hint="启动时、窗口回到前台时、每 60 秒，以及每次编辑落盘后各同步一次。关掉后一次都不碰服务器，只能手动点「同步」"
                  checked={p.autoSync}
                  onChange={(x) => setPref({ autoSync: x })}
                />
                {!props.sync.localServer?.running && (
                  <div className="set-row set-about">
                    <span className="set-label">
                      添加设备
                      <span className="set-hint">
                        生成一个 6 位配对码。在手机上打开 Ivyea Note，选「配对码」填进去即可——
                        不用输地址、不用输密码
                      </span>
                    </span>
                    <button className="btn" onClick={props.sync.onAddDevice}>
                      生成配对码
                    </button>
                  </div>
                )}
                <div className="set-row set-about">
                  <span className="set-label">
                    退出同步
                    <span className="set-hint">
                      只断开这台设备与服务器的连接，本机笔记一篇都不会删，之后随时能再连回来
                    </span>
                  </span>
                  <button className="btn" onClick={props.sync.onLogout}>
                    退出同步
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="set-hint">
                  当前是本地模式，笔记只存在这台设备上。开启同步之后，多台设备之间就会自动流动；
                  不开也能一直用。
                </p>
                <div className="set-row set-about">
                  <span className="set-label">
                    连到一台服务器
                    <span className="set-hint">
                      已经有服务器（自己搭的、或另一台电脑开着上面那个开关）就走这里
                    </span>
                  </span>
                  <button className="btn" onClick={props.sync.onOpenLogin}>
                    开启同步
                  </button>
                </div>
              </>
            )}
          </section>

          {props.agentSection && (
            <section className="set-section">
              <h3 className="set-h">Agent 接入</h3>
              {props.agentSection}
            </section>
          )}

          <section className="set-section">
            <h3 className="set-h">快捷键</h3>
            <ul className="set-keys">
              {SHORTCUTS.map((k) => (
                <li key={k.keys}>
                  <kbd>{k.keys}</kbd>
                  <span>{k.what}</span>
                </li>
              ))}
            </ul>
            <p className="set-hint">暂不支持自定义快捷键。</p>
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
              {props.storage.path
                ? '笔记就是你磁盘上的普通 Markdown 文件。卸载本软件后，用任何编辑器都能继续打开。'
                : props.storage.canPick
                  ? '当前笔记存在应用内部存储里，卸载会一并删除。在上面的「存储位置」选一个磁盘文件夹，笔记就会变成随时能用别的编辑器打开的普通 Markdown 文件。'
                  : '当前笔记存在浏览器的私有存储里，清除站点数据会一并删除。桌面版和手机 App 可以把它换成磁盘上的普通 Markdown 文件。'}
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

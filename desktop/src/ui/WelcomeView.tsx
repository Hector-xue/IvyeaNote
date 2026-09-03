/**
 * v0.4.0 T2：首启引导页（对标 Obsidian「30 秒开写」）。
 * 三张卡：打开本地文件夹 / 从 Obsidian 导入 / 新建空白库。
 * 全部免登录可用；仅当用户主动点「登录同步」才进入登录流程。
 */
import { RibbonIcon, type IconName } from './Icons';
import { useCallback } from 'react';
import logoUrl from '../assets/logo.png';

export interface WelcomeActions {
  onOpenFolder(): void;
  onImportObsidian(): void;
  onCreateBlank(): void;
  onOpenLogin(): void;
  /**
   * 「跳过」。此前这里是组件**自己**的 `dismissed` state，`return null` 之后
   * App 那一支照样 early-return，屏幕上只剩一个空的 `.app` —— 点一下就白屏，
   * 而且 markWelcomed 没写，刷新才回得来。收起欢迎页是 App 的事，得往上报。
   */
  onDismiss(): void;
}

/** 首启标记：完成任一动作后不再显示 */
const KEY = 'ivnote.welcomed';

export function isWelcomed(): boolean {
  return localStorage.getItem(KEY) === '1';
}
export function markWelcomed(): void {
  localStorage.setItem(KEY, '1');
}

export function WelcomeView(props: WelcomeActions) {
  const wrap = useCallback((fn: () => void) => () => {
    markWelcomed();
    fn();
  }, []);

  const cards: { icon: IconName; title: string; desc: string; action: () => void; primary?: boolean }[] = [
    {
      icon: 'folder' as const,
      title: '打开本地文件夹',
      desc: '选择电脑上的任意文件夹，直接作为笔记库使用',
      action: props.onOpenFolder,
      primary: true,
    },
    {
      icon: 'file-plus' as const,
      title: '从 Obsidian 导入',
      desc: '选择你的 Obsidian 库文件夹，一键搬进来',
      action: props.onImportObsidian,
    },
    {
      icon: 'plus' as const,
      title: '新建空白库',
      desc: '从零开始，创建一个全新的笔记空间',
      action: props.onCreateBlank,
    },
  ];

  return (
    <div className="welcome-mask">
      <div className="welcome-card">
        <img src={logoUrl} alt="" className="welcome-logo" />
        <h1>欢迎使用 Ivyea Note</h1>
        <p className="welcome-sub">本地优先 · 多端同步 · 纯 Markdown。选择一种方式开始：</p>
        <div className="welcome-cards">
          {cards.map((c) => (
            <button key={c.title} className={`welcome-item ${c.primary ? 'primary' : ''}`} onClick={wrap(c.action)}>
              <span className="wi-icon">
                <RibbonIcon name={c.icon} size={22} />
              </span>
              <span className="wi-title">{c.title}</span>
              <span className="wi-desc">{c.desc}</span>
            </button>
          ))}
        </div>
        <div className="welcome-foot">
          <button className="btn ghost" onClick={wrap(props.onDismiss)}>
            跳过，先随便看看
          </button>
          <button className="btn link" onClick={wrap(props.onOpenLogin)}>
            已有账号？登录同步
          </button>
        </div>
      </div>
    </div>
  );
}

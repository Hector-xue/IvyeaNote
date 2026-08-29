/**
 * 移动端底部常驻栏（v0.10.0）。
 *
 * 之前这里只有两个图标（插图、阅读切换）——那是 v0.7.2 定下的
 * 「底部仅留最小插入栏，格式化改成选中文字才浮气泡」。这个设计当时就是错的：
 * **光标停在那里想插一个标题、一条列表，没有任何入口**，必须先选中点什么东西。
 *
 * 现在照 Obsidian 移动端分两层：
 * - 下层是导航（返回 / 搜索 / 新建 / 格式 / 更多），常驻；
 * - 上层是格式条，点「格式」展开，横向可滚，收在导航之上——
 *   Obsidian 是键盘弹起时自动出现，WebView 里检测键盘不可靠，改成显式开关。
 */
import { RibbonIcon, type IconName } from '../Icons';

export interface FormatAction {
  key: string;
  icon: IconName;
  title: string;
  run(): void;
}

interface Props {
  /** 有笔记打开时，左键是「返回列表」 */
  canGoBack: boolean;
  formatOpen: boolean;
  /** 只读预览 / 阅读态下不给格式条 */
  formatAvailable: boolean;
  formats: FormatAction[];
  onBack(): void;
  onSearch(): void;
  onCreate(): void;
  onToggleFormat(): void;
  onMore(): void;
}

export function BottomBar(props: Props) {
  return (
    <div className="m-bottom-wrap">
      {props.formatOpen && props.formatAvailable && (
        <div className="m-format" role="toolbar" aria-label="格式">
          {props.formats.map((f) => (
            <button
              key={f.key}
              className="m-format-btn"
              title={f.title}
              aria-label={f.title}
              // 不让按钮抢走焦点，否则编辑器里的选区会在点击瞬间丢掉
              onPointerDown={(e) => e.preventDefault()}
              onClick={f.run}
            >
              <RibbonIcon name={f.icon} size={19} />
            </button>
          ))}
        </div>
      )}
      <nav className="m-bottom" aria-label="导航">
        <button className="m-nav-btn" onClick={props.onBack} disabled={!props.canGoBack} aria-label="返回列表">
          <RibbonIcon name="chevron-left" size={21} />
        </button>
        <button className="m-nav-btn" onClick={props.onSearch} aria-label="搜索">
          <RibbonIcon name="search" size={21} />
        </button>
        <button className="m-nav-btn" onClick={props.onCreate} aria-label="新建笔记">
          <RibbonIcon name="plus" size={21} />
        </button>
        <button
          className={`m-nav-btn ${props.formatOpen ? 'on' : ''}`}
          onClick={props.onToggleFormat}
          disabled={!props.formatAvailable}
          aria-label="格式"
        >
          <RibbonIcon name="text-format" size={21} />
        </button>
        <button className="m-nav-btn" onClick={props.onMore} aria-label="更多">
          <RibbonIcon name="more-vertical" size={21} />
        </button>
      </nav>
    </div>
  );
}

/**
 * 移动端底部常驻栏（v0.10.0）。
 *
 * 之前这里只有两个图标（插图、阅读切换）——那是 v0.7.2 定下的
 * 「底部仅留最小插入栏，格式化改成选中文字才浮气泡」。这个设计当时就是错的：
 * **光标停在那里想插一个标题、一条列表，没有任何入口**，必须先选中点什么东西。
 *
 * 现在照 Obsidian 移动端分两层：
 * - 下层是导航（搜索 / 新建 / 格式），常驻；
 * - 上层是格式条，点「格式」展开，横向可滚，收在导航之上——
 *   Obsidian 是键盘弹起时自动出现，WebView 里检测键盘不可靠，改成显式开关。
 *
 * v0.10.2：**删掉了「返回」与「更多」**。
 * 「返回」做的事就是打开抽屉，和顶栏左上角那个侧栏键一模一样（左缘右滑也是它）；
 * 「更多」连图标带动作与顶栏右上角**完全相同**（都是 setMenu('note')）。
 * 同一个功能在一屏里出现两次，用户第一反应是"这两个有什么区别"——没有区别，
 * 那就该只留一个。留在顶栏是因为它俩都跟着当前笔记走（面包屑就在旁边）。
 */
import { RibbonIcon, type IconName } from '../Icons';

export interface FormatAction {
  key: string;
  icon: IconName;
  title: string;
  run(): void;
}

interface Props {
  formatOpen: boolean;
  /** 只读预览 / 阅读态下不给格式条 */
  formatAvailable: boolean;
  formats: FormatAction[];
  onSearch(): void;
  onCreate(): void;
  onToggleFormat(): void;
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
      </nav>
    </div>
  );
}

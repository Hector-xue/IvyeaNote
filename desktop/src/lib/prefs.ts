/**
 * 行为偏好（v0.8.6 E10）。
 *
 * 与 `appearance.ts` 分开：那边全是「长什么样」（改的是 CSS 变量），这边是
 * 「怎么行为」（改的是代码分支）。混在一起会让 appearance 的「改即生效、
 * 纯样式、渲染前应用」那套前提失效。
 *
 * ⚠️ **每一项的默认值都必须等于「本次改动之前的行为」**。设置项的意义是让人
 * 能改，不是趁机换默认——一个从没打开过设置页的老用户，升级后必须一切照旧。
 */

import type { AttachMode } from './attachPath';

export interface Prefs {
  /** 打开笔记时的初始视图。默认 edit，与此前写死的行为一致 */
  defaultView: 'edit' | 'read';
  /** 编辑态实时预览（标题字号、加粗、任务框…）。关掉就是纯源码 */
  livePreview: boolean;
  /** 正文首个 H1 变化时自动重命名文件（v0.4.0 起的行为） */
  titleSync: boolean;
  /**
   * 自动同步：启动拉一次 + 窗口聚焦 + 每 60s 兜底轮询 + **每次编辑落盘后推一次**。
   * 关掉之后一次都不碰服务器，只能手动点「同步」——最后那条曾经漏掉过，
   * 于是「关掉后只能手动同步」是句假话（v0.9.2 修）。
   */
  autoSync: boolean;
  /**
   * 插入的图片存到哪。v0.10.7 起可选，默认**与笔记同一个文件夹**。
   *
   * ⚠️ 这一项是本文件开头那条「默认值必须等于改动前的行为」的**唯一例外**，
   * 而且是用户自己点名要改的：此前写死在库根 `Attachments/`，
   * 于是"把某个文件夹整个拷给别人"必然断图。已经躺在库根 Attachments/ 里的
   * 老图片一张都不动、照常显示——变的只是以后新插入的落点。
   */
  attachMode: AttachMode;
  /**
   * v0.11.18：**按内容自动选阅读密度**（字号 / 行宽 / 行高）。
   *
   * 默认关：它会改变正文的样子，而"从没打开过设置的老用户升级后一切照旧"是本文件
   * 开头那条铁律。打开之后由 `lib/density` 的纯函数按内容选档——不是问大模型，
   * 那种做法慢、花钱、而且同一篇两次可能给出不同答案。
   */
  autoDensity: boolean;
  /**
   * v0.11.18：大模型配置（OpenAI 兼容）。与 ivyea-translate 同一套三件套。
   *
   * ⚠️ Key 存在本机 localStorage 里，和其它偏好一样——这是个本地应用，
   * 没有服务端可以替你保管它。**它不会随笔记同步**（同步的只有 vault 里的文件）。
   */
  ai: AiPrefs;
}

export interface AiPrefs {
  /** 接口地址，比如 https://api.deepseek.com（少写 /v1 也认，见 lib/llm 的 chatUrl） */
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const AI_DEFAULTS: AiPrefs = { baseUrl: '', apiKey: '', model: '' };

export const PREF_DEFAULTS: Prefs = {
  defaultView: 'edit',
  livePreview: true,
  titleSync: true,
  autoSync: true,
  attachMode: 'beside',
  autoDensity: false,
  ai: AI_DEFAULTS,
};

const KEY = 'ivnote.prefs';

/** 读偏好。任何一项缺失/类型不对都退回默认，不让手改坏的 localStorage 影响功能 */
export function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>;
    return {
      defaultView: raw.defaultView === 'read' ? 'read' : PREF_DEFAULTS.defaultView,
      livePreview: typeof raw.livePreview === 'boolean' ? raw.livePreview : PREF_DEFAULTS.livePreview,
      titleSync: typeof raw.titleSync === 'boolean' ? raw.titleSync : PREF_DEFAULTS.titleSync,
      autoSync: typeof raw.autoSync === 'boolean' ? raw.autoSync : PREF_DEFAULTS.autoSync,
      attachMode:
        raw.attachMode === 'vault' || raw.attachMode === 'subfolder' || raw.attachMode === 'beside'
          ? raw.attachMode
          : PREF_DEFAULTS.attachMode,
      autoDensity: typeof raw.autoDensity === 'boolean' ? raw.autoDensity : PREF_DEFAULTS.autoDensity,
      ai: {
        baseUrl: typeof raw.ai?.baseUrl === 'string' ? raw.ai.baseUrl : '',
        apiKey: typeof raw.ai?.apiKey === 'string' ? raw.ai.apiKey : '',
        model: typeof raw.ai?.model === 'string' ? raw.ai.model : '',
      },
    };
  } catch {
    return { ...PREF_DEFAULTS };
  }
}

export function savePrefs(p: Prefs): void {
  localStorage.setItem(KEY, JSON.stringify(p));
}

/** 快捷键清单：设置页照着它渲染，改快捷键时这里和实现要一起改 */
export const SHORTCUTS: { keys: string; what: string }[] = [
  { keys: 'Ctrl / ⌘ + K', what: '全库搜索' },
  { keys: 'Ctrl / ⌘ + O', what: '快速切换笔记（模糊匹配）' },
  { keys: 'Ctrl / ⌘ + P', what: '命令面板' },
  { keys: 'Ctrl / ⌘ + F', what: '文内查找替换' },
  { keys: 'Ctrl / ⌘ + E', what: '切换编辑 / 阅读' },
  { keys: 'Ctrl / ⌘ + ,', what: '打开设置' },
  { keys: 'Esc', what: '关闭当前浮层' },
];

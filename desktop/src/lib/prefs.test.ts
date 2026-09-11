// @vitest-environment jsdom
/**
 * 行为偏好。
 *
 * 第一条也是最重要的一条：**每个默认值都必须等于「这些设置项存在之前的行为」**。
 * 一个从没打开过设置页的老用户，升级后必须一切照旧——设置项的意义是让人能改，
 * 不是趁机换默认。所以这里把四个默认值逐个钉死，改动它们必须先改测试。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { loadPrefs, PREF_DEFAULTS, savePrefs, SHORTCUTS } from './prefs';

beforeEach(() => localStorage.clear());

describe('默认值＝改动前的行为', () => {
  it('打开笔记进编辑态（此前写死 edit）', () => {
    expect(PREF_DEFAULTS.defaultView).toBe('edit');
  });
  it('实时预览开着（v0.5.0 起就是开的）', () => {
    expect(PREF_DEFAULTS.livePreview).toBe(true);
  });
  it('标题跟随文件名开着（v0.4.0 起的行为）', () => {
    expect(PREF_DEFAULTS.titleSync).toBe(true);
  });
  it('自动同步开着（v0.6.1 起的行为）', () => {
    expect(PREF_DEFAULTS.autoSync).toBe(true);
  });
  /**
   * attachMode 是这条铁律的**唯一例外**，而且是用户点名要改的（2026-09-03）：
   * 此前附件写死落在库根 `Attachments/`，笔记在子目录里时正文写出来的还是
   * 库根相对路径 —— 在 Obsidian / VSCode / GitHub 里全是断图。改默认之前
   * 先问过「不做任何设置的老用户会怎样」：已经躺在库根 Attachments/ 里的
   * 老图片一张不动、照常显示（读取侧有兜底），变的只是以后新插入的落点。
   */
  it('附件默认与笔记同一个文件夹（v0.10.7 起，唯一一处有意改掉的默认）', () => {
    expect(PREF_DEFAULTS.attachMode).toBe('beside');
  });
  it('没存过任何设置时读到的就是这套默认', () => {
    expect(loadPrefs()).toEqual(PREF_DEFAULTS);
  });
});

describe('读写与容错', () => {
  it('存了个不认识的 attachMode → 回落默认，而不是把附件写到一个没人预期的地方', () => {
    localStorage.setItem('ivnote.prefs', JSON.stringify({ attachMode: '随便写的' }));
    expect(loadPrefs().attachMode).toBe(PREF_DEFAULTS.attachMode);
  });

  it('存了能读回来', () => {
    savePrefs({
      defaultView: 'read',
      livePreview: false,
      titleSync: false,
      autoSync: false,
      attachMode: 'vault',
      autoDensity: true,
      htmlScripts: 'always',
      htmlScriptFiles: ['工具/a.html'],
      ai: {
        baseUrl: 'https://api.example.com',
        apiKey: 'k',
        model: 'm',
        actions: [{ id: 'a1', label: '客户口吻', instruction: '改成给客户看的口吻', mode: 'replace' }],
      },
    });
    expect(loadPrefs()).toEqual({
      defaultView: 'read',
      livePreview: false,
      titleSync: false,
      autoSync: false,
      attachMode: 'vault',
      autoDensity: true,
      htmlScripts: 'always',
      htmlScriptFiles: ['工具/a.html'],
      ai: {
        baseUrl: 'https://api.example.com',
        apiKey: 'k',
        model: 'm',
        actions: [{ id: 'a1', label: '客户口吻', instruction: '改成给客户看的口吻', mode: 'replace' }],
      },
    });
  });

  it('HTML 脚本默认不跑（v0.11.24 新增，老用户升级后行为不变）', () => {
    expect(PREF_DEFAULTS.htmlScripts).toBe('ask');
    expect(PREF_DEFAULTS.htmlScriptFiles).toEqual([]);
    localStorage.setItem('ivnote.prefs', JSON.stringify({ htmlScripts: 'yolo', htmlScriptFiles: [1, 'x.html'] }));
    expect(loadPrefs().htmlScripts).toBe('ask');
    expect(loadPrefs().htmlScriptFiles).toEqual(['x.html']);
  });

  /*
   * 存下来的动作要**逐条**校验：手改坏（或旧版本写下）的一条，
   * 不该把其余几条一起吃掉——那是"我的自定义动作全没了"。
   */
  it('自定义动作逐条校验，坏的丢掉、好的留下', () => {
    localStorage.setItem(
      'ivnote.prefs',
      JSON.stringify({
        ai: {
          baseUrl: 'x',
          apiKey: '',
          model: 'm',
          actions: [
            { id: 'ok', label: '好的', instruction: '做点什么', mode: 'produce' },
            { id: 'bad', label: '缺 mode', instruction: '做点什么' },
            null,
            'not-an-object',
          ],
        },
      })
    );
    expect(loadPrefs().ai.actions).toEqual([{ id: 'ok', label: '好的', instruction: '做点什么', mode: 'produce' }]);
  });

  it('从没存过 actions 的老配置读回来是空数组，不是 undefined', () => {
    localStorage.setItem('ivnote.prefs', JSON.stringify({ ai: { baseUrl: 'x', apiKey: '', model: 'm' } }));
    expect(loadPrefs().ai.actions).toEqual([]);
  });

  it('只存了一部分时，其余项回落默认而不是 undefined', () => {
    localStorage.setItem('ivnote.prefs', JSON.stringify({ livePreview: false }));
    expect(loadPrefs()).toEqual({ ...PREF_DEFAULTS, livePreview: false });
  });

  it('类型不对的值一律当没写过——手改坏的 localStorage 不该让功能失灵', () => {
    localStorage.setItem(
      'ivnote.prefs',
      JSON.stringify({ livePreview: 'yes', autoSync: 1, defaultView: 'zzz' })
    );
    expect(loadPrefs()).toEqual(PREF_DEFAULTS);
  });

  it('存成非 JSON 也不抛', () => {
    localStorage.setItem('ivnote.prefs', '{坏了');
    expect(loadPrefs()).toEqual(PREF_DEFAULTS);
  });
});

describe('快捷键清单', () => {
  it('设置页照它渲染，所以每条都得有键位和说明', () => {
    expect(SHORTCUTS.length).toBeGreaterThan(0);
    for (const s of SHORTCUTS) {
      expect(s.keys.trim()).not.toBe('');
      expect(s.what.trim()).not.toBe('');
    }
  });
  it('实现里有的几个主快捷键都列上了', () => {
    const keys = SHORTCUTS.map((s) => s.keys).join(' ');
    for (const k of ['+ K', '+ O', '+ P', '+ F', '+ E', '+ ,']) expect(keys).toContain(k);
  });
});

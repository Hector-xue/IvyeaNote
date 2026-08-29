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
  it('没存过任何设置时读到的就是这套默认', () => {
    expect(loadPrefs()).toEqual(PREF_DEFAULTS);
  });
});

describe('读写与容错', () => {
  it('存了能读回来', () => {
    savePrefs({ defaultView: 'read', livePreview: false, titleSync: false, autoSync: false });
    expect(loadPrefs()).toEqual({
      defaultView: 'read',
      livePreview: false,
      titleSync: false,
      autoSync: false,
    });
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

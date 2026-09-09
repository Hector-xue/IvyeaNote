/**
 * 左侧栏的两个面板：标签、回收站（v0.11.16）。
 *
 * # 为什么从弹窗搬进侧栏
 *
 * 用户原话：「最左侧的侧边栏的回收站的 UI，标签的 UI，都需要优化，你自己去看看
 * 现在的 UI，很乱，视觉上体验很差」。
 *
 * 乱的根子不在配色，在**同一排按钮做着两类事**：ribbon 上「文件 / 搜索」是切换
 * 左栏内容的，而「标签 / 回收站 / 图谱」点了会盖一张对话框上来。同一个位置、
 * 同样的图标，一半是导航一半是弹窗，人当然摸不着规律。
 *
 * 所以标签和回收站都变成**左栏的面板**，和文件树、搜索并列——这也是 Obsidian
 * 的做法（标签面板、搜索面板都在左栏）。图谱进右栏，见 ui/RightPanel。
 *
 * # 两个面板共用一套行的形状
 *
 * `.sp-row` 是一行：图标 + 名字（可带次要行）+ 右侧计数或动作。列表类界面的
 * "整齐"就来自这里——行高一致、图标一栏对齐、右侧信息右对齐。此前回收站那张表
 * 是「名字 + 两个实心按钮」平铺，按钮把每一行撑得一样宽又一样重，扫一眼全是按钮。
 */
import { useMemo, useState } from 'react';
import { RibbonIcon } from './Icons';
import { buildTagIndex } from '../lib/tags';
import { originalPathOf } from '../hooks/useTrash';
import type { SearchDoc } from '../lib/searchIndex';

/** 名字（去扩展名）与所在目录，列表里分两级显示 */
function splitPath(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf('/');
  return {
    name: (i < 0 ? path : path.slice(i + 1)).replace(/\.(md|markdown)$/i, ''),
    dir: i < 0 ? '' : path.slice(0, i),
  };
}

export interface TagPaneProps {
  docs: readonly SearchDoc[];
  /** 点一个标签：调用方决定怎么搜（桌面切到搜索面板，手机灌进抽屉搜索框） */
  onPick(tag: string): void;
}

/**
 * 标签面板。
 *
 * 此前是一片大小不一的圆角胶囊（tag-cloud）——标签一多就成了一堵墙，
 * 而且没有任何办法在里面找一个标签。现在是一列可筛选的行，右侧对齐引用次数。
 */
export function TagPane({ docs, onPick }: TagPaneProps) {
  const [q, setQ] = useState('');
  const tags = useMemo(() => {
    const idx = buildTagIndex(docs as SearchDoc[]);
    const key = q.trim().replace(/^#/, '').toLowerCase();
    return [...idx.entries()]
      .filter(([tag]) => !key || tag.toLowerCase().includes(key))
      // 常用的排前面；次数相同按名字，免得每次进来顺序都在跳
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'zh-Hans-CN'));
  }, [docs, q]);

  return (
    <div className="side-pane">
      <div className="sp-search">
        <RibbonIcon name="search" size={14} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="筛选标签"
          aria-label="筛选标签"
        />
        {q && (
          <button className="sp-clear" onClick={() => setQ('')} aria-label="清空">
            <RibbonIcon name="close" size={13} />
          </button>
        )}
      </div>
      {tags.length === 0 ? (
        <p className="sp-empty">{q ? '没有匹配的标签' : '还没有标签。在笔记里写 #标签 即可。'}</p>
      ) : (
        <div className="sp-list">
          {tags.map(([tag, paths]) => (
            <button key={tag} className="sp-row" onClick={() => onPick(tag)} title={`搜索 #${tag}`}>
              <span className="sp-ico">
                <RibbonIcon name="tag" size={14} />
              </span>
              <span className="sp-name">{tag}</span>
              <span className="sp-count">{paths.length}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export interface TrashPaneProps {
  /** `.trash/…` 下的路径列表 */
  list: readonly string[];
  onRestore(path: string): void;
  onPurge(path: string): void;
  /** 清空整个回收站；不传就不显示那个入口 */
  onPurgeAll?(): void;
}

/**
 * 回收站面板。
 *
 * 每行显示的是**原来的名字和原来的目录**（回收站里的文件名是
 * `2026-09-09T…-目录__文件.md` 这种带时间戳的编码形式，直接摆出来没人看得懂）。
 * 两个动作收进行尾的图标里，hover 才浮现：回收站是个偶尔来一次的地方，
 * 常显的按钮只会把列表变成按钮墙。
 */
export function TrashPane({ list, onRestore, onPurge, onPurgeAll }: TrashPaneProps) {
  return (
    <div className="side-pane">
      <div className="sp-head">
        <span className="sp-head-title">{list.length > 0 ? `${list.length} 项` : '空'}</span>
        {onPurgeAll && list.length > 0 && (
          <button className="sp-link danger" onClick={onPurgeAll}>
            清空
          </button>
        )}
      </div>
      {list.length === 0 ? (
        <p className="sp-empty">回收站是空的。删掉的笔记会先到这里，可以原路恢复。</p>
      ) : (
        <div className="sp-list">
          {list.map((p) => {
            const { name, dir } = splitPath(originalPathOf(p));
            return (
              <div key={p} className="sp-row sp-row-static" title={originalPathOf(p)}>
                <span className="sp-ico">
                  <RibbonIcon name="file" size={14} />
                </span>
                <span className="sp-text">
                  <span className="sp-name">{name}</span>
                  {dir && <span className="sp-sub">{dir}</span>}
                </span>
                <span className="sp-actions">
                  <button
                    className="sp-act"
                    title="恢复到原位置"
                    aria-label="恢复到原位置"
                    onClick={() => onRestore(p)}
                  >
                    <RibbonIcon name="undo" size={14} />
                  </button>
                  <button
                    className="sp-act danger"
                    title="彻底删除"
                    aria-label="彻底删除"
                    onClick={() => onPurge(p)}
                  >
                    <RibbonIcon name="trash" size={14} />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

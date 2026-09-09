/**
 * 移动端底部弹层的**外壳**（v0.11.18）。
 *
 * # 为什么抽出来
 *
 * 手机上有四处底部弹层：动作菜单、长按操作单、大纲、重命名、回收站。此前每一处
 * 都自己拼一遍「遮罩 + 纸 + 把手 + 标题」，于是形状、圆角、安全区各自演化，
 * 改一处忘另一处。手势更是只能有一份实现——四份手势代码必然行为不一致。
 *
 * # 这一版的设计取舍
 *
 * 用户原话：「这种弹窗为什么这么多横线还长短不一，好难看」。看截图数一下，
 * 一屏里有三种长度的线：组内那条从文字处起画的缩进线、组间那条通栏线、
 * 外加大纲下面那条。**线在替留白干活**——而它干不好这活：长度一不一致就碎，
 * 一致了又把一张纸切成好几段。
 *
 * 所以：**一根线都不画，分组交给留白**。这也是 iOS 的 context menu、Obsidian
 * 移动端菜单的做法——一张纸上只有间距。行高 52px、图标一栏对齐，本来就读得清，
 * 不需要线来告诉人"这是两行"。
 *
 * 另外两件事顺手做掉：
 *
 * - **把手不再是假的。** 画了一条可拖的把手，却只能点遮罩关闭——这是界面在
 *   撒谎。现在按住头部下滑就能关（跟手位移，松手按距离与速度判定）。
 *   手势只挂在头部：内容区要能正常滚动（大纲动辄几十条），把手势挂在整张纸上
 *   会把滚动吞掉。
 * - **菜单要有主语。** 「重命名 / 移动到 / 删除」作用在哪一篇？此前整张纸上
 *   没有任何交代。现在头部给一行弱化的上下文（笔记名）。
 */
import { useEffect, useRef, useState } from 'react';

interface Props {
  open: boolean;
  /** 头部那行弱化的上下文，比如当前笔记名。不给就只有把手 */
  title?: string;
  /** 无障碍名称；不给就用 title */
  label?: string;
  /** 额外类名，给大纲这种要撑高的场景用 */
  className?: string;
  onClose(): void;
  children: React.ReactNode;
}

/** 松手就关的位移阈值（px）与速度阈值（px/ms）。两者满足其一即关 */
const CLOSE_DISTANCE = 90;
const CLOSE_VELOCITY = 0.5;

export function BottomSheet({ open, title, label, className, onClose, children }: Props) {
  /*
   * **刚弹出来的一瞬间不接受遮罩点击。**
   *
   * 长按呼出这张卡时，手指抬起后浏览器还会补一次 click，坐标就是刚才按住的位置——
   * 那里此刻已经被遮罩盖住，于是「长按 → 卡片弹出 → 立刻自己关掉」，
   * 看起来就是长按压根没反应。350ms 足够甩掉那次合成点击，又短到用户感觉不出来。
   */
  const openedAt = useRef(0);
  const drag = useRef<{ y: number; t: number } | null>(null);
  const [dragY, setDragY] = useState(0);

  useEffect(() => {
    if (open) {
      openedAt.current = Date.now();
      setDragY(0);
    }
  }, [open]);

  if (!open) return null;

  const maskClick = () => {
    if (Date.now() - openedAt.current < 350) return;
    onClose();
  };

  const onTouchStart = (e: React.TouchEvent) => {
    drag.current = { y: e.touches[0].clientY, t: Date.now() };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const s = drag.current;
    if (!s) return;
    // 只跟向下的手势：往上拖不该把纸拉高（那会露出遮罩下面的空隙）
    const dy = e.touches[0].clientY - s.y;
    setDragY(dy > 0 ? dy : 0);
  };
  const onTouchEnd = () => {
    const s = drag.current;
    drag.current = null;
    const dt = s ? Math.max(1, Date.now() - s.t) : 1;
    const fast = dragY / dt > CLOSE_VELOCITY;
    // 甩一下就走（短距离但快），或者拖过一段距离
    if (dragY > CLOSE_DISTANCE || (fast && dragY > 24)) onClose();
    else setDragY(0);
  };

  return (
    <div className="m-sheet-mask" onClick={maskClick}>
      <div
        className={`m-sheet2 ${className ?? ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={label ?? title ?? '菜单'}
        onClick={(e) => e.stopPropagation()}
        style={dragY > 0 ? { transform: `translateY(${dragY}px)`, transition: 'none' } : undefined}
      >
        {/* 手势只挂在头部：内容区要能正常滚动 */}
        <div
          className="m-sheet2-head"
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={onTouchEnd}
        >
          <div className="m-sheet2-grip" aria-hidden="true" />
          {title && <div className="m-sheet2-title">{title}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}

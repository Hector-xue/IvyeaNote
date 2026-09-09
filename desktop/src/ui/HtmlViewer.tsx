/**
 * 应用内 HTML 查看器（v0.11.18）。
 *
 * 用户原话：「在我的 ivyeanote 能直接浏览 html 文件吗？我测试了下，现在是点开
 * html 文件然后跳转到浏览器浏览查看的」。
 *
 * # 三个必须想清楚的问题
 *
 * ## 1. 脚本要不要跑？——默认不跑
 *
 * 库里的 `.html` 可能是从任何地方存下来的（网页存档、导出的报表、别人发来的文件）。
 * 在应用内执行它的脚本，等于把一段来路不明的代码放进笔记软件的进程里。
 *
 * 所以 sandbox **只给 `allow-same-origin`，绝不给 `allow-scripts`**：
 * 没有 `allow-scripts` 就一行脚本都跑不了，同源也就无从被利用（危险的是这两个
 * 一起给）。
 *
 * ⚠️ 一开始写的是 `sandbox=""`（更严），实测**整个页面是空白的**：Chromium 不给
 * 不透明来源的 `srcdoc` 建子帧——CDP 的 `Page.getFrameTree` 里连那个 frame 都不存在，
 * 而 iframe 元素、srcdoc 属性、尺寸全都正常，所以从外面看只能看到"一片白"。
 * 这类"元素在、内容没有"的坑，只有真的进到子帧里数一遍才发现得了。
 *
 * 真要跑脚本的（比如自带交互的报表），工具条上有「用浏览器打开」——那条路本来就在，
 * 现在它从"唯一选择"降级成"逃生出口"。
 *
 * ## 2. 相对路径的图片和样式怎么办？
 *
 * `srcdoc` 没有基地址，`<img src="img/a.png">` 一定裂。所以渲染前先把 HTML 解析成
 * DOM，把相对路径的图片换成库里读出来的 blob URL、把相对路径的样式表读成内联
 * `<style>`。这和阅读视图里图片的解析规则是同一件事（见 MarkdownEditor 的
 * `resolveImagesIn`），只是这里还多一层样式。
 *
 * ## 3. 手机上怎么读一张给电脑设计的页面？（v0.11.20）
 *
 * 用户发来的截图：一份左侧目录 + 右侧正文的 HTML 手册，在手机上左边目录占掉一半，
 * 右边正文每行只剩两三个字，竖着流下去——**没法读**。
 *
 * 根子在于 iframe 是它自己的视口。手机浏览器打开这种页面时会按 980px 排版再整体
 * 缩小（overview mode），而 iframe 只有屏幕那么宽，于是作者按 1000px 写的两栏
 * 被硬塞进 390px。
 *
 * 两条路，我们都给，默认按页面自己有没有为手机做过适配来选：
 * - **重排**（窄屏默认）：注入一张覆盖样式，把 flex/grid/浮动/固定定位统统拍平成
 *   自上而下的块，宽度一律跟着视口。字号保持作者的原值，所以**读得清**。
 *   代价是设计感会丢一部分——但读不了的排版没有设计可言。
 * - **原样**：一个字不动。页面自己声明了 `viewport width=device-width`（说明作者
 *   做过手机适配）时默认走这条，工具条上也随时能切回来。
 *
 * 为什么不做"按比例缩小"：iframe 里缩到 0.4 倍，16px 的正文只剩 6px，
 * 而沙箱 iframe 里双指放大会连整个应用一起放大。缩小等于把不能读换成看不清。
 *
 * ## 4. 链接点了去哪？
 *
 * 沙箱 iframe 里的链接点了什么都不会发生（没有 `allow-top-navigation`），
 * 那就等于"链接坏了"。所以拦下点击：库内的 `.md` 用应用打开，外部链接交给浏览器。
 * iframe 里的点击拿不到（跨文档），所以监听的是 iframe 内部 document——
 * `srcdoc` 且同源被禁时读不到 contentDocument，因此改用**注入前重写 href**：
 * 把链接换成 `data-ivnote-href`，再由外层用 `pointerdown` 捕获坐标命中判断行不通……
 * 实测最稳的一条：把所有 `<a>` 的 `target` 设成 `_blank` 并保留 href，同时在
 * 工具条上给「用浏览器打开」——沙箱会拦下导航，但用户至少看得见链接指向哪儿
 * （hover 有 title）。真要跳转就用工具条那颗按钮。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { RibbonIcon } from './Icons';
import { resolveVaultPath } from '../lib/links';

interface Props {
  /** 库内相对路径，用来解析相对资源与显示文件名 */
  path: string;
  /** 文件原文 */
  html: string;
  /** 把库内相对路径读成可显示的 URL（图片等二进制） */
  resolveAsset(rel: string): Promise<string | null>;
  /** 把库内相对路径读成文本（样式表） */
  readText(rel: string): Promise<string>;
  onClose(): void;
  /** 交给系统浏览器打开（要跑脚本时的出口） */
  onOpenExternal?(): void;
}

/** 文件名（去目录） */
function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

/**
 * 页面有没有为手机做过适配：认 `<meta name="viewport" content="...width=device-width...">`。
 * 这是作者的**声明**，不是猜测——声明过就照他的来，没声明的才轮到我们重排。
 */
export function declaresMobileViewport(html: string): boolean {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const meta = doc.querySelector('meta[name="viewport" i]');
  const content = meta?.getAttribute('content') ?? '';
  return /width\s*=\s*device-width/i.test(content);
}

/**
 * 重排用的覆盖样式：**把二维布局拍平成一维**。
 *
 * 选择器写成 `html body :is(...)`（0,0,2）而不是 `*`：
 * `*` 会把 `<span>`、`<code>` 这些行内元素也变成块，一句话被拆成一行一个词。
 * 只拍容器类元素，行内排版留给作者。
 *
 * 表格不拍——拍了就没有行列了；给它自己的横向滚动条。
 */
const REFLOW_CSS = `
html, body {
  width: auto !important; min-width: 0 !important; max-width: 100% !important;
  margin: 0 !important; overflow-x: hidden !important;
}
body { padding: 12px !important; }
html body :is(div, section, article, aside, nav, main, header, footer, form, ul, ol, dl, figure) {
  display: block !important;
  position: static !important;
  float: none !important;
  width: auto !important; min-width: 0 !important; max-width: 100% !important;
  height: auto !important; max-height: none !important;
  margin-left: 0 !important; margin-right: 0 !important;
  transform: none !important;
  overflow: visible !important;
}
html body :is(img, video, canvas, svg, iframe) { max-width: 100% !important; height: auto !important; }
html body :is(pre, code) { white-space: pre-wrap !important; word-break: break-word !important; }
html body table { display: block !important; width: max-content !important; max-width: 100% !important; overflow-x: auto !important; }
`;

/** 把重排样式塞进 </head> 之前；没有 head 就贴在最前面 */
function withReflow(html: string, on: boolean): string {
  if (!on || !html) return html;
  const tag = `<style data-ivnote="reflow">${REFLOW_CSS}</style>`;
  return html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : tag + html;
}

export function HtmlViewer(props: Props) {
  const [doc, setDoc] = useState<string>('');
  const [note, setNote] = useState<string | null>(null);
  const urls = useRef<string[]>([]);
  /**
   * 默认值只在打开新文件时定一次：作者声明过手机适配就原样，否则重排。
   * 之后用户在工具条上怎么切就是怎么切——不能每次重渲染又把他的选择顶回去。
   */
  const [reflow, setReflow] = useState(false);
  useEffect(() => {
    const narrow = window.innerWidth < 700;
    setReflow(narrow && !declaresMobileViewport(props.html));
  }, [props.path, props.html]);
  const srcDoc = useMemo(() => withReflow(doc, reflow), [doc, reflow]);

  useEffect(() => {
    let cancelled = false;
    const revoke = () => {
      for (const u of urls.current) URL.revokeObjectURL(u);
      urls.current = [];
    };
    void (async () => {
      revoke();
      const parsed = new DOMParser().parseFromString(props.html, 'text/html');
      let missing = 0;

      // 图片：相对路径 → 库里读出来的 blob URL
      for (const img of Array.from(parsed.querySelectorAll('img'))) {
        const src = img.getAttribute('src') ?? '';
        if (!src || /^(https?:|data:|blob:)/i.test(src)) continue;
        try {
          const url = await props.resolveAsset(resolveVaultPath(props.path, src));
          if (url) {
            img.setAttribute('src', url);
            urls.current.push(url);
          } else missing++;
        } catch {
          missing++;
        }
      }

      // 外部样式表：读成内联 <style>（sandbox 下不会去发网络请求，相对路径也拿不到）
      for (const link of Array.from(parsed.querySelectorAll('link[rel="stylesheet"]'))) {
        const href = link.getAttribute('href') ?? '';
        if (!href || /^https?:/i.test(href)) {
          link.remove();
          continue;
        }
        try {
          const css = await props.readText(resolveVaultPath(props.path, href));
          const style = parsed.createElement('style');
          style.textContent = css;
          link.replaceWith(style);
        } catch {
          link.remove();
          missing++;
        }
      }

      // 链接：保留 href（hover 看得见去哪），但沙箱会拦下导航
      for (const a of Array.from(parsed.querySelectorAll('a[href]'))) {
        a.setAttribute('title', a.getAttribute('href') ?? '');
        a.setAttribute('target', '_blank');
      }

      if (cancelled) return;
      setDoc('<!doctype html>' + parsed.documentElement.outerHTML);
      setNote(missing > 0 ? `有 ${missing} 个引用的资源没找到（图片或样式表）` : null);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.path, props.html]);

  // 组件卸载时把 blob URL 收掉，否则每开一次就漏一批
  useEffect(
    () => () => {
      for (const u of urls.current) URL.revokeObjectURL(u);
      urls.current = [];
    },
    []
  );

  return (
    <div className="html-view">
      <div className="html-bar">
        <RibbonIcon name="file" size={15} />
        <span className="html-name" title={props.path}>
          {baseName(props.path)}
        </span>
        {note && <span className="html-note">{note}</span>}
        <span className="html-gap" />
        {/* 沙箱里不跑脚本，所以要留一条真能跑的路 */}
        {/*
          v0.11.20：给电脑设计的页面在手机上没法读（用户截图：左边目录占一半，
          右边正文每行两三个字）。这颗按钮在"重排"与"原样"之间切。
        */}
        <button
          className={`icon-btn ${reflow ? 'on' : ''}`}
          title={reflow ? '当前：重排以适应屏幕（点这里看原始排版）' : '当前：原始排版（点这里重排以适应屏幕）'}
          aria-pressed={reflow}
          aria-label="重排以适应屏幕"
          onClick={() => setReflow((v) => !v)}
        >
          <RibbonIcon name={reflow ? 'list-ul' : 'table'} size={15} />
        </button>
        {props.onOpenExternal && (
          <button className="icon-btn" title="用浏览器打开（可执行脚本）" onClick={props.onOpenExternal}>
            <RibbonIcon name="external-link" size={15} />
          </button>
        )}
        <button className="icon-btn" title="关闭" aria-label="关闭" onClick={props.onClose}>
          <RibbonIcon name="close" size={15} />
        </button>
      </div>
      <iframe
        className="html-frame"
        title={baseName(props.path)}
        /*
         * 只给 same-origin，不给 scripts：脚本一行都跑不了。
         * 空 sandbox 会让 srcdoc 根本不加载（见文件头那段），别再"更严"了。
         */
        sandbox="allow-same-origin"
        srcDoc={srcDoc}
      />
    </div>
  );
}

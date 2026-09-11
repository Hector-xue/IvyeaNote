/**
 * 库里的 HTML 工具在沙箱里跑脚本时需要的几件小东西（v0.11.24）。
 *
 * 用户原话：「这种工具类的 HTML 能做到直接在笔记里面使用吗？」——他把 AI 生成的
 * 「划线价与 BD 维护助手」存进库里，点开只看到一条「此工具需要浏览器允许 JavaScript」。
 *
 * # 跑脚本，但不给同源
 *
 * iframe 的 sandbox 给 `allow-scripts`、**不给** `allow-same-origin`：页面在一个
 * 不透明来源（origin = null）里跑，摸不到应用的 DOM、localStorage、Tauri IPC。
 * 危险的是两个一起给（脚本可以自己把 sandbox 属性摘掉），单给 allow-scripts 是安全的。
 *
 * # 代价：localStorage 没了——所以补一个
 *
 * 不透明来源里 `window.localStorage` 一碰就抛 SecurityError，而"台账 / 历史记录"类
 * 工具全靠它存数据。这里在页面自己的脚本之前注入一段 shim：用内存对象顶替
 * localStorage / sessionStorage（`Object.defineProperty(window, 'localStorage', …)`，
 * Chromium 里这两个是可配置属性，实测能覆盖），每次写入 postMessage 给外层，
 * 外层落到 `<文件>.data.json`——**和笔记一起同步**，所以手机上打开同一份工具，
 * 台账是一样的。这和浏览器里"数据只在这台电脑的这个浏览器里"相比反而更好。
 *
 * `document.cookie` 在不透明来源里同样会抛，给它一个空实现；`indexedDB` 不管
 * （用它的工具不多，而且模拟一个 IDB 不是几十行的事）。
 *
 * # 图片得是 data: URL
 *
 * 外层解析相对路径图片时给的是 blob: URL——**跨源的 iframe 读不到父页面的 blob**
 * （headless Chrome 实测 naturalWidth = 0），所以脚本模式下一律转成 data: URL。
 */

/** 存到 `<文件>.data.json` 里的形状 */
export interface HtmlStorageFile {
  ivnote: 'html-storage';
  version: 1;
  local: Record<string, string>;
}

/** 数据文件路径：紧挨着 HTML，改名 / 移动时要一起搬（lib/movePath） */
export function storagePathFor(htmlPath: string): string {
  return `${htmlPath}.data.json`;
}

export function isStoragePath(path: string): boolean {
  return /\.html?\.data\.json$/i.test(path);
}

/** 读 `.data.json`；坏文件 / 老格式一律当空，别让一个坏 JSON 挡住工具打开 */
export function parseStorageFile(text: string | null): Record<string, string> {
  if (!text) return {};
  try {
    const raw = JSON.parse(text) as unknown;
    if (!raw || typeof raw !== 'object') return {};
    const local = (raw as { local?: unknown }).local ?? raw;
    if (!local || typeof local !== 'object' || Array.isArray(local)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(local as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeStorageFile(local: Record<string, string>): string {
  const body: HtmlStorageFile = { ivnote: 'html-storage', version: 1, local };
  return JSON.stringify(body, null, 2) + '\n';
}

/** 页面里有没有会跑的东西：<script>、on* 内联处理器、javascript: 链接 */
export function hasScripts(doc: Document): boolean {
  if (doc.querySelector('script')) return true;
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    for (const a of Array.from(el.attributes)) {
      if (/^on[a-z]+$/i.test(a.name)) return true;
      if ((a.name === 'href' || a.name === 'src') && /^\s*javascript:/i.test(a.value)) return true;
    }
  }
  return false;
}

/** 内嵌进 <script> 的 JSON：`</script>` 和 U+2028 之类不能原样出现 */
function jsonForScript(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * 注入到页面 <head> 最前面的 shim。**必须在页面自己的任何脚本之前**，
 * 否则它们第一行 `localStorage.getItem` 就抛了。
 *
 * 实现要点（headless Chrome 实测过）：
 * - Proxy 是为了 `localStorage.foo` / `Object.keys(localStorage)` / `JSON.stringify(localStorage)`
 *   这些"把它当普通对象用"的写法；
 * - `length` 必须定义成 configurable，否则 Proxy 的 ownKeys 不返回它会抛 TypeError；
 * - 每次写都把整份数据 post 出去（工具的数据都很小，省得做增量协议）。
 */
export function storageShim(initial: Record<string, string>): string {
  return `(function(){
var init=${jsonForScript({ local: initial })};
function make(name,data){
  var store=data||{};
  function post(){try{parent.postMessage({type:'ivnote-storage',name:name,data:store},'*');}catch(e){}}
  var api={
    getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(store,k)?store[k]:null;},
    setItem:function(k,v){store[String(k)]=String(v);post();},
    removeItem:function(k){delete store[String(k)];post();},
    clear:function(){for(var k in store)delete store[k];post();},
    key:function(i){var ks=Object.keys(store);return i<ks.length?ks[i]:null;}
  };
  Object.defineProperty(api,'length',{get:function(){return Object.keys(store).length;},configurable:true});
  if(typeof Proxy!=='function')return api;
  return new Proxy(api,{
    get:function(t,k){if(k in t)return t[k];return typeof k==='string'&&Object.prototype.hasOwnProperty.call(store,k)?store[k]:undefined;},
    set:function(t,k,v){if(k in t)return false;t.setItem(k,v);return true;},
    deleteProperty:function(t,k){t.removeItem(k);return true;},
    has:function(t,k){return k in t||Object.prototype.hasOwnProperty.call(store,k);},
    ownKeys:function(){return Object.keys(store);},
    getOwnPropertyDescriptor:function(t,k){if(Object.prototype.hasOwnProperty.call(store,k))return{value:store[k],writable:true,enumerable:true,configurable:true};return undefined;}
  });
}
try{Object.defineProperty(window,'localStorage',{value:make('local',init.local),configurable:true});}catch(e){}
try{Object.defineProperty(window,'sessionStorage',{value:make('session',{}),configurable:true});}catch(e){}
try{Object.defineProperty(Document.prototype,'cookie',{get:function(){return '';},set:function(){},configurable:true});}catch(e){}
})();`;
}

/**
 * 窄屏"该不该重排"的量法要在 iframe 里面跑（跨源读不到 contentDocument），
 * 结果 postMessage 回来。`measure` 是 ui/HtmlViewer 的 needsReflow 的源码。
 */
export function measureScript(measureFnSource: string): string {
  return `(function(){
function go(){try{var need=(${measureFnSource})(document,window.innerWidth);parent.postMessage({type:'ivnote-measure',reflow:!!need},'*');}catch(e){}}
if(document.readyState==='complete')go();else window.addEventListener('load',go);
})();`;
}

/** blob: → data:（外层同源，读得到） */
export async function blobUrlToDataUrl(url: string): Promise<string> {
  const blob = await (await fetch(url)).blob();
  return await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

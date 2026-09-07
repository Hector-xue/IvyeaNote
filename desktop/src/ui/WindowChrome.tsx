/**
 * 「这份运行环境要不要自绘窗口边框」的唯一判定（v0.11.0；v0.11.4 起只剩这一个函数）。
 *
 * 窗口按钮的渲染搬进了 `TopBar`——它们本来就该长在顶栏右端（Obsidian 就是这样），
 * 而不是自己占一条横栏或者浮在半空。
 *
 * # 用户说的是哪一条
 *
 * 「还有我上次让你删除的这个顶部栏」——v0.10.7 删掉的是**标签栏**，而截图里圈的
 * 是 Windows 自己的**标题栏**（左边应用名、右边最小化/最大化/关闭）。它一直都在，
 * 因为 `tauri.conf.json` 从来没设过 `decorations: false`。
 * 「整个窗口还不是 R 角」是同一件事的另一半：我量过截图，(0,0) 是桌面色、(1,1)
 * 已经是白色——这台机器上窗口是直角（Win10 不会自动给窗口倒角）。
 *
 * # 做法与代价
 *
 * `decorations: false` + `transparent: true`（只写在 `tauri.windows.conf.json` 里，
 * Linux/macOS 保持原生边框，不去冒它们各自合成器的风险），圆角由 CSS 画。
 * 代价是系统投影没有了，所以这里补一条极淡的描边——不然窗口在浅色桌面上会没有边界。
 * **最大化时必须收成直角**：圆角留着的话，四个角会露出桌面，非常明显。
 *
 * 非 Windows / 非 Tauri（浏览器、安卓）一律返回 null：那些环境本来就没有我们该画的边框。
 */
/** 这份运行环境需不需要自绘边框 */
export function needsCustomChrome(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if (!('__TAURI_INTERNALS__' in window)) return false;
  // 安卓的 UA 里也有 "Windows"？没有；但保险起见先排除移动端
  if (/Android|iPhone|iPad/i.test(navigator.userAgent)) return false;
  return /Windows/i.test(navigator.userAgent);
}

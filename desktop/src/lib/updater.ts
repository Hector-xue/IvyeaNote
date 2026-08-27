// v0.7.2：应用内更新。桌面端走 tauri-plugin-updater（静默检查 → Dialog → 下载安装重启）；
// 移动端（Android）无法静默替换 APK，检测到新版本后引导跳转 Release 页下载。
import { openUrl } from "@tauri-apps/plugin-opener";

export const RELEASE_PAGE = "https://github.com/Hector-xue/IvyeaNote/releases/latest";

/** 与 App.tsx 同款 Tauri 环境探测 */
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface UpdateInfo {
  version: string;
  notes?: string;
}

/** 是否为移动端（Android/iOS）：updater 插件仅支持桌面 */
function isMobile(): boolean {
  return /android|iphone|ipad/i.test(navigator.userAgent);
}

/**
 * 检查更新。
 * - 桌面 + Tauri 环境：调 updater 插件，返回新版本信息（无更新返回 null）
 * - Android：比较 GitHub latest Release 版本号，有新版返回 {version}，由调用方引导去下载
 * - 浏览器/非 Tauri：返回 null（不支持）
 */
export async function checkForUpdate(currentVersion: string): Promise<UpdateInfo | null> {
  if (!isTauri()) return null;
  if (isMobile()) return checkMobileUpdate(currentVersion);
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return null;
    return { version: update.version, notes: update.body ?? undefined };
  } catch (e) {
    console.error("[updater] 检查失败", e);
    throw e;
  }
}

/** Android 端：拉 GitHub latest release 的 tag，与当前版本比较 */
async function checkMobileUpdate(currentVersion: string): Promise<UpdateInfo | null> {
  try {
    const res = await fetch(
      "https://api.github.com/repos/Hector-xue/IvyeaNote/releases/latest",
      { headers: { Accept: "application/vnd.github+json" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const tag: string | undefined = data?.tag_name;
    if (!tag) return null;
    const remote = tag.replace(/^v/, "").trim();
    if (remote && isNewer(remote, currentVersion)) return { version: remote };
    return null;
  } catch (e) {
    console.error("[updater] 移动端检查失败", e);
    return null;
  }
}

/** 语义化版本比较：a > b 返回 true（逐段数值比较，段数不足补 0） */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/** 桌面端执行更新：下载 → 校验签名 → 安装 → 重启应用 */
export async function installUpdate(onProgress?: (received: number) => void): Promise<void> {
  if (!isTauri()) return;
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) return;
  let received = 0;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      received = 0;
    } else if (event.event === "Progress") {
      received += event.data.chunkLength;
      onProgress?.(received);
    } else if (event.event === "Finished") {
      onProgress?.(received);
    }
  });
  // 安装完成，重启应用进入新版本
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

/** 移动端：打开 Release 页面让用户手动下载 APK */
export async function openReleasePage(): Promise<void> {
  try {
    await openUrl(RELEASE_PAGE);
  } catch {
    window.open(RELEASE_PAGE, "_blank");
  }
}

/** v0.7.4：语义化版本比较（a > b 返回 true）；忽略非数字段 */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

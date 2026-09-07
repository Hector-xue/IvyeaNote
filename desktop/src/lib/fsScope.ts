/**
 * 把笔记库目录递归加进 Tauri 的文件系统作用域（v0.11.4）。Rust 实现见 `src-tauri/src/fsscope.rs`。
 *
 * 不做这件事的后果很隐蔽：**已有笔记读写一切正常，唯独在子目录里新建附件被拒**——
 * 因为绑定文件夹时的作用域是对话框插件顺手给的，且只放行库根那一层。
 * 「粘贴图片没反应」连报四轮，根因就在这儿。
 */
export async function allowVaultPath(path: string | null | undefined): Promise<void> {
  if (!path || path.startsWith('opfs://')) return;
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('allow_vault_path', { path });
  } catch {
    // 旧构建没有这个命令：静默降级——它只是让作用域更宽，缺了不会让别的功能坏掉
  }
}

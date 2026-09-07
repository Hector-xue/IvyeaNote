//! 把笔记库目录**递归**加进文件系统作用域（v0.11.4）。
//!
//! # 为什么需要它
//!
//! 用户反馈「粘贴图片依旧不能用」，第四轮才拿到真正的错误：
//! `forbidden path: E:\obsidian\obsidian/亚马逊/20260907-image.png`。
//!
//! 读源码定位到两件事叠在一起：
//!
//! 1. 绑定文件夹时，作用域是**对话框插件**顺手授予的：
//!    `tauri-plugin-dialog` 里 `s.allow_directory(&path, options.recursive)`，
//!    而 `recursive` 在我们的调用里没传、默认 `false` —— `allow_directory(p, false)`
//!    只压入 `p` 和 `p/*` 两个模式，配合 `require_literal_separator: true`，
//!    **只放行库根那一层**，子目录一律不放行。
//! 2. `tauri::scope::fs` 的 `try_resolve_symlink_and_canonicalize` 只对
//!    **已存在**的路径做 `canonicalize`，不存在的原样返回。于是"读已有笔记"
//!    和"写一个还不存在的附件"走的是两条不同形状的路径。
//!
//! 两件事叠起来的表现就是：**笔记读写一切正常，唯独新建附件被拒**——
//! 而在 v0.11.3 之前这个失败是**完全静默**的，所以连报四轮都定位不到。
//!
//! 这里不再依赖对话框那次顺带授权：每次激活笔记库（绑定时、以及每次启动恢复上次的库）
//! 都用**我们自己拿到的那个路径字符串**递归授权一次。幂等，重复调用只是多压几个模式。

use tauri::{AppHandle, Runtime};
use tauri_plugin_fs::FsExt;

/// 递归放行一个笔记库目录。
///
/// `path` 必须是**磁盘绝对路径**；应用内部存储（`opfs://` 开头）没有磁盘路径，直接跳过。
#[tauri::command]
pub fn allow_vault_path<R: Runtime>(app: AppHandle<R>, path: String) -> Result<(), String> {
    if path.is_empty() || path.starts_with("opfs://") {
        return Ok(());
    }
    let scope = app.fs_scope();
    scope
        .allow_directory(&path, true)
        .map_err(|e| format!("放行笔记库目录失败：{e}"))?;
    Ok(())
}

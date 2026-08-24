// Ivyea Note 桌面端入口：注册 fs / dialog 插件。
// 业务逻辑（同步、编辑）全部在前端 WebView 里，Rust 侧保持最薄。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("Ivyea Note 启动失败");
}

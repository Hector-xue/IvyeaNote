// Ivyea Note 应用入口（lib 形式：桌面 binary 与 Android/iOS 共用）。
// 业务逻辑（同步、编辑）全部在前端 WebView 里，Rust 侧保持最薄。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("Ivyea Note 启动失败");
}

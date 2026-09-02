// v0.7.0 H9: LAN discovery (Rust side).
pub mod discover;
pub use discover::discover_servers;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // v0.7.2：应用内更新（桌面端）。updater 负责检查/下载/校验，process 负责重启安装
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // 安卓 SAF：桌面端注册后所有命令返回 Unsupported，前端按平台分流，不影响桌面
        .plugin(tauri_plugin_ivnote_saf::init())
        .invoke_handler(tauri::generate_handler![discover_servers])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

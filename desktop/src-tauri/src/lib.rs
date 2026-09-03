// v0.7.0 H9: LAN discovery (Rust side).
pub mod discover;
pub use discover::discover_servers;
// v0.10.5：内置同步服务端（sidecar 起停）。Windows+安卓这个主场景不该要求用户先搭服务器
pub mod localserver;

// `AppHandle::state()` 来自 Manager trait，退出钩子里要用
use tauri::Manager;

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
        .manage(localserver::LocalServer::default())
        .invoke_handler(tauri::generate_handler![
            discover_servers,
            localserver::start_local_server,
            localserver::stop_local_server,
            localserver::local_server_status,
            localserver::local_server_available
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            /*
             * 退出时收掉内置服务端。
             *
             * `std::process::Child` 的 Drop **不会**杀子进程，而 sidecar 是用
             * CREATE_NO_WINDOW 起的（Windows 上连个能关的窗口都没有）——
             * 于是关掉 Ivyea Note 之后，那个 ivnote-server 还在后台占着 8080，
             * 用户只能去任务管理器里找。下次启动看到端口通，还会把这个孤儿
             * 当成"已经在跑"直接复用。
             */
            if let tauri::RunEvent::Exit = event {
                localserver::stop(&app.state::<localserver::LocalServer>());
            }
        });
}

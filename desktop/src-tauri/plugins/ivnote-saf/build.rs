// 命令名要与 src/lib.rs 里的 #[tauri::command] 一一对应，
// 少一个就是运行时「命令未注册」，多一个则生成用不上的权限文件。
const COMMANDS: &[&str] = &[
    "pick_vault_folder",
    "list_entries",
    "read_text",
    "read_binary",
    "write_text",
    "write_binary",
    "remove_entry",
    "entry_exists",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}

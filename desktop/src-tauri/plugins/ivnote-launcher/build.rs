// 命令名要与 src/lib.rs 里的 #[tauri::command] 一一对应，少一个就是运行时「命令未注册」。
//
// `register_listener` / `remove_listener` 两条**没有** Rust 实现：JS 的 addPluginListener
// 调的是 `plugin:ivnote-launcher|register_listener`，Rust 侧没命中的插件命令会被 Tauri
// 转发给 Kotlin 基类（Plugin.registerListener）——但 ACL 检查发生在转发之前，
// 不在这里列出来就是「not allowed by ACL」（官方 notification 插件也是这么列的）。
const COMMANDS: &[&str] = &[
    "take_launch_action",
    "set_shortcuts",
    "set_note_snapshot",
    "bound_notes",
    "rebind_notes",
    "pin_note_widget",
    "register_listener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}

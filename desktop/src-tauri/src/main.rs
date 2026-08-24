// Ivyea Note 桌面端入口：调用共用的 lib::run()。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ivyea_note_desktop_lib::run();
}

//! 安卓桌面入口：长按图标快捷方式 + 桌面小部件（v0.11.30；v0.11.31 加最近笔记 / 待办；v0.11.32 笔记卡片加配置页）。
//!
//! # 为什么是一个独立插件
//!
//! `gen/android` 不入库，CI 每次发版都 `cargo tauri android init` 重新生成——
//! `MainActivity.kt` 和 app 的 `AndroidManifest.xml` 改了也会被冲掉。
//! 所以小部件的 receiver、快捷方式的发布、启动意图的解析全部放在这个插件的
//! 安卓 library 模块里：receiver 靠 manifest 合并进 app，资源随库打包。
//!
//! # 分工
//!
//! - **Kotlin** 只做系统那一侧的事：解析启动 intent、发布快捷方式、把 JS 推来的
//!   笔记快照画成 RemoteViews。它**不读笔记文件**——安卓上的库要么在 WebView 的
//!   OPFS 里（原生读不到），要么在 SAF 树里（能读但要走 ContentResolver 跨进程），
//!   而小部件在 App 进程没起来时也得能画，所以内容必须提前存成快照。
//! - **JS** 决定"显示什么"：哪篇是最近打开的、哪几篇要做成快捷方式、快照文本
//!   怎么从 Markdown 剥出来；并在启动 / 收到事件时来领取「要做什么」。
//! - 这里的 **Rust** 只是桥：安卓走 `PluginHandle::run_mobile_plugin`，其它平台一律
//!   `Unsupported`（前端按平台守卫，桌面永远不会调到）。

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(target_os = "android")]
use tauri::plugin::PluginHandle;

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.ivyea.note.launcher";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("桌面快捷方式与小部件只在安卓上可用")]
    Unsupported,
    #[cfg(target_os = "android")]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
}

impl Serialize for Error {
    // 写全 `std::result::Result`：下面的 `Result<T>` 别名只收一个泛型参数（同 ivnote-saf）
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// 从快捷方式 / 小部件进来时要做的事。`kind` 取值见 Kotlin 侧 LaunchIntents：
/// `new`（新建笔记）/ `daily`（今日日记）/ `open`（打开某篇）/ `app`（只是打开应用）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchAction {
    pub kind: String,
    /// `open` 时是哪个库；其它动作为 0
    pub vault_id: i64,
    /// `open` 时是哪篇（库内相对路径）；其它动作为空串
    pub path: String,
    /// 原生侧收到这个 intent 的毫秒时间戳；JS 据此丢掉太旧的动作
    pub at: i64,
}

/// 领取结果：`action` 为 None 表示没有待处理的动作
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TakeResult {
    pub action: Option<LaunchAction>,
}

/// 一条快捷方式（长按图标菜单里的一行）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutSpec {
    /// `new` / `daily` / `open`
    pub kind: String,
    pub label: String,
    pub vault_id: i64,
    pub path: String,
}

/// 一篇笔记在小部件上的快照
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSnapshot {
    pub vault_id: i64,
    pub path: String,
    pub title: String,
    /// 已经剥掉 Markdown 记号的纯文本，JS 侧截过长度
    pub preview: String,
    /// 毫秒时间戳
    pub mtime: i64,
    /// true = 这篇同时是"最近打开的一篇"，没绑定具体笔记的小部件显示它
    pub recent: bool,
}

/// 某个小部件绑定的笔记
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundNote {
    pub vault_id: i64,
    pub path: String,
}

#[derive(Deserialize)]
struct BoundResult {
    notes: Vec<BoundNote>,
}

/// 改名 / 移动：把绑定里的旧路径换成新路径
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebindOp {
    pub from_vault_id: i64,
    pub from: String,
    pub to_vault_id: i64,
    pub to: String,
}

/// `pin_note_widget` 的结果。`mode`：
/// - `requested`：已弹出系统的「添加到桌面」确认框；
/// - `bound`：桌面上已有没绑笔记的卡片，直接绑上了（个数在 `count`）；
/// - `pending`：这台启动器不支持一键添加，已记下来，用户手动添加的下一张卡片会绑到这篇。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PinResult {
    pub mode: String,
    pub count: i64,
}

/// 「最近笔记」小部件的一行
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentNote {
    pub vault_id: i64,
    pub path: String,
    pub title: String,
    /// 毫秒时间戳
    pub mtime: i64,
}

/// 「待办」小部件的一条：`raw` 是 `- [ ]` 后面的 Markdown 原文（改文件时拿它核对那一行），
/// `text` 是剥掉记号后给人看的；`line` 是 0 起的行号。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    /// 只有原生交回来的队列条目才带（当时列表属于哪个库）；JS 推列表时为 0
    #[serde(default)]
    pub vault_id: i64,
    pub path: String,
    pub title: String,
    pub line: i64,
    pub raw: String,
    pub text: String,
}

/// 整份待办列表。`root` 是库在磁盘上的位置（`content://` 树 / 绝对路径 / `opfs://…`），
/// App 没在跑时原生据此决定能不能自己改文件。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoSnapshot {
    pub vault_id: i64,
    pub root: String,
    pub items: Vec<TodoItem>,
}

/// 当前库的全部笔记（笔记卡片配置页选用）。`root` 同 TodoSnapshot。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteList {
    pub vault_id: i64,
    pub root: String,
    pub items: Vec<RecentNote>,
}

#[derive(Deserialize)]
struct PendingResult {
    items: Vec<TodoItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecentListArg<'a> {
    items: &'a [RecentNote],
}

#[derive(Serialize)]
struct TodoLiveArg {
    live: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShortcutsArg<'a> {
    shortcuts: &'a [ShortcutSpec],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RebindArg<'a> {
    ops: &'a [RebindOp],
}

#[cfg(target_os = "android")]
pub struct Launcher<R: Runtime>(PluginHandle<R>);

// 非安卓占位：`PhantomData<fn() -> R>` 无条件 Send + Sync（原因见 ivnote-saf 的注释）
#[cfg(not(target_os = "android"))]
pub struct Launcher<R: Runtime>(std::marker::PhantomData<fn() -> R>);

#[cfg(target_os = "android")]
impl<R: Runtime> Launcher<R> {
    fn call<A: Serialize, T: serde::de::DeserializeOwned>(&self, cmd: &str, args: A) -> Result<T> {
        Ok(self.0.run_mobile_plugin(cmd, args)?)
    }
}

#[cfg(not(target_os = "android"))]
impl<R: Runtime> Launcher<R> {
    fn call<A: Serialize, T: serde::de::DeserializeOwned>(&self, _c: &str, _a: A) -> Result<T> {
        Err(Error::Unsupported)
    }
}

// ---------- 命令 ----------

/// 领走待处理的启动动作（领走即清空）。
#[tauri::command]
fn take_launch_action<R: Runtime>(app: tauri::AppHandle<R>) -> Result<TakeResult> {
    // 传 `()` 会序列化成 JSON null，移动端桥那边期望一个对象
    app.state::<Launcher<R>>()
        .inner()
        .call("takeLaunchAction", serde_json::json!({}))
}

/// 整体替换长按图标菜单里的快捷方式（顺序即排名）。
#[tauri::command]
fn set_shortcuts<R: Runtime>(app: tauri::AppHandle<R>, shortcuts: Vec<ShortcutSpec>) -> Result<()> {
    let _: serde_json::Value = app.state::<Launcher<R>>().inner().call(
        "setShortcuts",
        ShortcutsArg {
            shortcuts: &shortcuts,
        },
    )?;
    Ok(())
}

/// 推一篇笔记的快照；原生侧存下并立刻重画显示它的小部件。
#[tauri::command]
fn set_note_snapshot<R: Runtime>(app: tauri::AppHandle<R>, snapshot: NoteSnapshot) -> Result<()> {
    let _: serde_json::Value = app
        .state::<Launcher<R>>()
        .inner()
        .call("setNoteSnapshot", snapshot)?;
    Ok(())
}

/// 桌面上所有小部件绑定的笔记（去重）。JS 启动时据此决定要推哪些快照。
#[tauri::command]
fn bound_notes<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Vec<BoundNote>> {
    let r: BoundResult = app
        .state::<Launcher<R>>()
        .inner()
        .call("boundNotes", serde_json::json!({}))?;
    Ok(r.notes)
}

/// 改名 / 移动 / 库 id 变化后更新绑定。
#[tauri::command]
fn rebind_notes<R: Runtime>(app: tauri::AppHandle<R>, ops: Vec<RebindOp>) -> Result<()> {
    let _: serde_json::Value = app
        .state::<Launcher<R>>()
        .inner()
        .call("rebindNotes", RebindArg { ops: &ops })?;
    Ok(())
}

/// 把一篇笔记放到桌面上（见 PinResult）。快照随请求一起带过去，确认框里就能预览。
#[tauri::command]
fn pin_note_widget<R: Runtime>(app: tauri::AppHandle<R>, snapshot: NoteSnapshot) -> Result<PinResult> {
    app.state::<Launcher<R>>()
        .inner()
        .call("pinNoteWidget", snapshot)
}

/// 「最近笔记」小部件的整份列表（顺序即显示顺序，JS 已截过条数）。
#[tauri::command]
fn set_recent_notes<R: Runtime>(app: tauri::AppHandle<R>, items: Vec<RecentNote>) -> Result<()> {
    let _: serde_json::Value = app
        .state::<Launcher<R>>()
        .inner()
        .call("setRecentNotes", RecentListArg { items: &items })?;
    Ok(())
}

/// 当前库的全部笔记（路径 / 标题 / 修改时间），笔记卡片的配置页从这里列给用户选。
#[tauri::command]
fn set_note_list<R: Runtime>(app: tauri::AppHandle<R>, list: NoteList) -> Result<()> {
    let _: serde_json::Value = app
        .state::<Launcher<R>>()
        .inner()
        .call("setNoteList", list)?;
    Ok(())
}

/// 「待办」小部件的整份列表；原生侧存下并立刻重画。
#[tauri::command]
fn set_todo_snapshot<R: Runtime>(app: tauri::AppHandle<R>, snapshot: TodoSnapshot) -> Result<()> {
    let _: serde_json::Value = app
        .state::<Launcher<R>>()
        .inner()
        .call("setTodoSnapshot", snapshot)?;
    Ok(())
}

/// 桌面上勾掉了、原生没能写进文件的那些（领走即清空）。JS 起来后逐条落到笔记里。
#[tauri::command]
fn take_pending_toggles<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Vec<TodoItem>> {
    let r: PendingResult = app
        .state::<Launcher<R>>()
        .inner()
        .call("takePendingToggles", serde_json::json!({}))?;
    Ok(r.items)
}

/// 告诉原生 JS 正在（或不再）监听 `todo` 事件：在听时勾选交给 JS 改文件，不在听时原生自己来。
#[tauri::command]
fn set_todo_live<R: Runtime>(app: tauri::AppHandle<R>, live: bool) -> Result<()> {
    let _: serde_json::Value = app
        .state::<Launcher<R>>()
        .inner()
        .call("setTodoLive", TodoLiveArg { live })?;
    Ok(())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("ivnote-launcher")
        .invoke_handler(tauri::generate_handler![
            take_launch_action,
            set_shortcuts,
            set_note_snapshot,
            bound_notes,
            rebind_notes,
            pin_note_widget,
            set_recent_notes,
            set_note_list,
            set_todo_snapshot,
            take_pending_toggles,
            set_todo_live
        ])
        .setup(|app, _api| {
            #[cfg(target_os = "android")]
            let launcher =
                Launcher(_api.register_android_plugin(PLUGIN_IDENTIFIER, "LauncherPlugin")?);
            #[cfg(not(target_os = "android"))]
            let launcher = Launcher::<R>(std::marker::PhantomData);
            app.manage(launcher);
            Ok(())
        })
        .build()
}

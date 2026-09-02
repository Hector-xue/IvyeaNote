//! 安卓 Storage Access Framework（SAF）桥接。
//!
//! # 为什么需要这个插件
//!
//! 安卓上笔记默认存在 WebView 的 OPFS 里，也就是应用私有数据区——**卸载即清空**。
//! 想让笔记落在用户自己选的目录（`Documents/我的笔记`、SD 卡、同步盘…），就必须走
//! Android 的 Storage Access Framework：用 `ACTION_OPEN_DOCUMENT_TREE` 让用户挑一棵
//! 目录树，拿到 `content://` URI 并持久化授权，之后所有读写都通过 `ContentResolver`。
//!
//! `tauri-plugin-dialog` 2.7.2 的安卓实现里只有 `ACTION_GET_CONTENT`（选单个文件）和
//! `ACTION_CREATE_DOCUMENT`（另存为），`mobile.rs` 里**根本没有 `pick_folder`**——
//! 所以「安卓上选不了目录」不是没接上，是上游没实现。只能自己写。
//!
//! # 设计要点
//!
//! SAF 的每一次目录查询都是一次 `ContentResolver` 跨进程调用，**逐个文件去问代价极高**。
//! 所以这里刻意不做成"一个路径一个命令"的细粒度接口：`list_entries` 一次调用就把整棵树
//! （相对路径 + 修改时间 + 大小）全带回来，Kotlin 侧再按这份结果建立 路径→documentId
//! 的缓存，后续读写直接命中缓存，不再重新走树。
//!
//! 桌面端不受影响：这些命令在非安卓平台一律返回 `Unsupported`，调用方按平台分流。

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(target_os = "android")]
use tauri::plugin::PluginHandle;

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.ivyea.note.saf";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("SAF 只在安卓上可用")]
    Unsupported,
    #[cfg(target_os = "android")]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
}

impl Serialize for Error {
    // 必须写全 `std::result::Result`：本模块下面那个 `Result<T>` 别名只收一个泛型参数，
    // 直接写 `Result<S::Ok, S::Error>` 会被它遮蔽，报 "expected 1 generic argument"
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// 用户选中的目录树。`uri` 是 `content://` 形式，作为 vault 的 localPath 落盘。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PickedFolder {
    pub uri: String,
    /// 给人看的名字（系统目录选择器返回的显示名），用于界面上展示"存在哪儿"
    pub name: String,
}

/// 一个条目。`path` 是相对所选目录树的路径，用 `/` 分隔，目录不出现在结果里。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub path: String,
    /// 毫秒时间戳；SAF 拿不到时为 0
    pub mtime: i64,
    pub size: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeArg<'a> {
    tree: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PathArg<'a> {
    tree: &'a str,
    path: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WriteTextArg<'a> {
    tree: &'a str,
    path: &'a str,
    content: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WriteBinaryArg<'a> {
    tree: &'a str,
    path: &'a str,
    /// base64。二进制走 JSON 桥必须编码，直接塞字节数组会被 JSON 序列化撑爆
    base64: &'a str,
}

#[derive(Deserialize)]
struct TextResult {
    content: String,
}

#[derive(Deserialize)]
struct BinaryResult {
    base64: String,
}

#[derive(Deserialize)]
struct BoolResult {
    value: bool,
}

#[derive(Deserialize)]
struct EntriesResult {
    entries: Vec<Entry>,
}

#[cfg(target_os = "android")]
pub struct Saf<R: Runtime>(PluginHandle<R>);

/*
 * 非安卓平台的占位实现。
 *
 * 这里必须是 `PhantomData<fn() -> R>` 而不是 `PhantomData<R>`：
 * `PhantomData<R>` 只有在 `R: Send + Sync` 时才是 `Send + Sync`，而 `R: Runtime`
 * 并不保证这一点，于是 `app.manage()` / `app.state()` 的 `Send + Sync` 约束通不过
 * （CI 一次报了 26 个 E0277）。`fn() -> R` 这种函数指针型的 PhantomData
 * **无条件**是 Send + Sync，又同样能占住类型参数，是标准做法。
 */
#[cfg(not(target_os = "android"))]
pub struct Saf<R: Runtime>(std::marker::PhantomData<fn() -> R>);

#[cfg(target_os = "android")]
impl<R: Runtime> Saf<R> {
    fn call<A: Serialize, T: serde::de::DeserializeOwned>(&self, cmd: &str, args: A) -> Result<T> {
        Ok(self.0.run_mobile_plugin(cmd, args)?)
    }
}

#[cfg(not(target_os = "android"))]
impl<R: Runtime> Saf<R> {
    fn call<A: Serialize, T: serde::de::DeserializeOwned>(&self, _c: &str, _a: A) -> Result<T> {
        Err(Error::Unsupported)
    }
}

// ---------- 命令 ----------

#[tauri::command]
fn pick_vault_folder<R: Runtime>(app: tauri::AppHandle<R>) -> Result<PickedFolder> {
    // 传 `()` 会序列化成 JSON null，而移动端桥那边期望一个对象；给个空对象最稳
    app.state::<Saf<R>>()
        .inner()
        .call("pickVaultFolder", serde_json::json!({}))
}

#[tauri::command]
fn list_entries<R: Runtime>(app: tauri::AppHandle<R>, tree: String) -> Result<Vec<Entry>> {
    let r: EntriesResult = app
        .state::<Saf<R>>()
        .inner()
        .call("listEntries", TreeArg { tree: &tree })?;
    Ok(r.entries)
}

#[tauri::command]
fn read_text<R: Runtime>(app: tauri::AppHandle<R>, tree: String, path: String) -> Result<String> {
    let r: TextResult = app.state::<Saf<R>>().inner().call(
        "readText",
        PathArg {
            tree: &tree,
            path: &path,
        },
    )?;
    Ok(r.content)
}

#[tauri::command]
fn read_binary<R: Runtime>(app: tauri::AppHandle<R>, tree: String, path: String) -> Result<String> {
    let r: BinaryResult = app.state::<Saf<R>>().inner().call(
        "readBinary",
        PathArg {
            tree: &tree,
            path: &path,
        },
    )?;
    Ok(r.base64)
}

#[tauri::command]
fn write_text<R: Runtime>(
    app: tauri::AppHandle<R>,
    tree: String,
    path: String,
    content: String,
) -> Result<()> {
    let _: serde_json::Value = app.state::<Saf<R>>().inner().call(
        "writeText",
        WriteTextArg {
            tree: &tree,
            path: &path,
            content: &content,
        },
    )?;
    Ok(())
}

#[tauri::command]
fn write_binary<R: Runtime>(
    app: tauri::AppHandle<R>,
    tree: String,
    path: String,
    base64: String,
) -> Result<()> {
    let _: serde_json::Value = app.state::<Saf<R>>().inner().call(
        "writeBinary",
        WriteBinaryArg {
            tree: &tree,
            path: &path,
            base64: &base64,
        },
    )?;
    Ok(())
}

#[tauri::command]
fn remove_entry<R: Runtime>(app: tauri::AppHandle<R>, tree: String, path: String) -> Result<()> {
    let _: serde_json::Value = app.state::<Saf<R>>().inner().call(
        "removeEntry",
        PathArg {
            tree: &tree,
            path: &path,
        },
    )?;
    Ok(())
}

#[tauri::command]
fn entry_exists<R: Runtime>(app: tauri::AppHandle<R>, tree: String, path: String) -> Result<bool> {
    let r: BoolResult = app.state::<Saf<R>>().inner().call(
        "entryExists",
        PathArg {
            tree: &tree,
            path: &path,
        },
    )?;
    Ok(r.value)
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("ivnote-saf")
        .invoke_handler(tauri::generate_handler![
            pick_vault_folder,
            list_entries,
            read_text,
            read_binary,
            write_text,
            write_binary,
            remove_entry,
            entry_exists
        ])
        .setup(|app, _api| {
            #[cfg(target_os = "android")]
            let saf = Saf(_api.register_android_plugin(PLUGIN_IDENTIFIER, "SafPlugin")?);
            #[cfg(not(target_os = "android"))]
            let saf = Saf::<R>(std::marker::PhantomData);
            app.manage(saf);
            Ok(())
        })
        .build()
}

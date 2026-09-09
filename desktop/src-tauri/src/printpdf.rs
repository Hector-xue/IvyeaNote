//! 导出为 PDF：**直接写出一个 PDF 文件，不弹打印机**（v0.11.16）。
//!
//! # 为什么要有这一层
//!
//! 此前「导出为 PDF」调的是 `window.print()`——弹出来的是系统打印对话框，
//! 用户得在里面找一个叫「Microsoft Print to PDF」的虚拟打印机，再点一次保存。
//! 用户的原话：「为什么导出为 PDF 还需要链接打印机？这跟我的需求不一样啊，
//! 我的需求是直接能转成 PDF 文件」。他要的是：选个位置 → 出一个 .pdf，完事。
//!
//! WebView2 自己就能干这件事：`ICoreWebView2_7::PrintToPdf` 按**打印样式表**
//! 排版并直接写文件，出来的是矢量 PDF——文字可选中、可搜索、可被简历筛选系统解析。
//! 这一点很重要：把网页截成图再拼成 PDF 也能交差，但那种 PDF 里"文字"是像素。
//!
//! # 平台边界
//!
//! 只有 Windows 这条路是原生的。macOS / Linux 上仍然退回打印对话框——
//! macOS 的打印面板左下角自带「存储为 PDF」，够用；Linux 的 WebKitGTK 要另写一套
//! `WebKitPrintOperation`。前端按 `export_pdf_supported()` 分流，不会先让用户
//! 选完保存位置再告诉他不支持。
//!
//! # 这里的代码本机编译不到
//!
//! 和 `firewall.rs` 一样：开发机没有 cargo，Windows 那一支**只有 CI 才编得到**
//! （desktop-check 在 windows-latest 上跑 cargo check）。所以照同样的规矩写：
//! 一个薄壳 + 按平台各一份实现，而不是在函数体里塞两个 cfg 块。

/// 这个平台能不能直接导出 PDF。false = 前端退回打印对话框。
#[tauri::command]
pub fn export_pdf_supported() -> bool {
    supported_impl()
}

#[cfg(windows)]
fn supported_impl() -> bool {
    true
}

#[cfg(not(windows))]
fn supported_impl() -> bool {
    false
}

/// 把当前窗口按打印样式渲染成 PDF，写到 `path`。路径由前端的保存对话框给。
#[tauri::command]
pub async fn export_pdf(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    export_impl(window, path).await
}

#[cfg(windows)]
async fn export_impl(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    use std::sync::mpsc::{channel, RecvTimeoutError};
    use std::time::Duration;
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2PrintSettings, ICoreWebView2_7};
    use webview2_com::PrintToPdfCompletedHandler;
    use windows_core::{Interface, HSTRING};

    let (tx, rx) = channel::<Result<(), String>>();

    /*
     * `with_webview` 把闭包扔到主线程上跑。所以这个命令**必须是 async**：
     * 同步命令本身就在主线程上，再去 run_on_main_thread 会直接锁死。
     * 闭包只负责发起，等结果在下面的 recv——PrintToPdf 的回调也在主线程上，
     * 主线程不能被我们占着。
     */
    window
        .with_webview(move |webview| {
            let target = HSTRING::from(path.as_str());
            let done = tx.clone();
            let started = (|| -> windows_core::Result<()> {
                let core = unsafe { webview.controller().CoreWebView2()? };
                let printer: ICoreWebView2_7 = core.cast()?;
                let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, ok| {
                    // 第一个参数是 HRESULT 转过来的 Result，第二个是"成功了没有"
                    let out = match (result, ok) {
                        (Err(e), _) => Err(format!("WebView2 报错：{e}")),
                        (Ok(()), true) => Ok(()),
                        (Ok(()), false) => {
                            Err("WebView2 说这次没写成（多半是保存位置不可写）".to_string())
                        }
                    };
                    let _ = done.send(out);
                    Ok(())
                }));
                // 第二个参数是打印设置，None = 默认（纵向、不带页眉页脚）
                unsafe {
                    printer.PrintToPdf(&target, None::<&ICoreWebView2PrintSettings>, &handler)
                }
            })();
            if let Err(e) = started {
                let _ = tx.send(Err(format!("调用 PrintToPdf 失败：{e}")));
            }
        })
        .map_err(|e| format!("拿不到 WebView：{e}"))?;

    // 长文排版要时间，但也不能无限等——超时了要说话，不能让按钮一直转
    match rx.recv_timeout(Duration::from_secs(120)) {
        Ok(r) => r,
        Err(RecvTimeoutError::Timeout) => Err("导出超时（超过 2 分钟）".to_string()),
        Err(RecvTimeoutError::Disconnected) => Err("导出中断：WebView 没有回话".to_string()),
    }
}

#[cfg(not(windows))]
async fn export_impl(_window: tauri::WebviewWindow, _path: String) -> Result<(), String> {
    // 前端会先问 export_pdf_supported()，正常不该走到这里；真走到了也要说清楚
    Err("这个平台还没有原生 PDF 导出，请用打印对话框里的「另存为 PDF」".to_string())
}

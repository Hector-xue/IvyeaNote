//! 内置同步服务端（v0.10.5）。
//!
//! # 为什么内置
//!
//! 用户群体大多是「一台 Windows + 一部安卓」。这个组合要同步，此前得先自己搭一台
//! 服务器——而 `start.bat` 第一句就在检测 Docker。可服务端**默认后端就是 SQLite**，
//! 密钥和管理员账号都会自动生成，本质上就是「一个 exe 跑起来就完事」。
//!
//! 所以这里把它作为 Tauri sidecar 随桌面包一起发，设置里一个开关就能起停：
//! 起服务 → 自动建账号 → 自动登录 → 出配对码；手机同一 Wi-Fi 下「找找附近的电脑」
//! 自动填地址，再输 6 位码。全程不碰命令行。
//!
//! # 为什么不用 tauri-plugin-shell
//!
//! 那条路要多引一个插件、多一套权限作用域，而这台机器上**编译不了 Tauri**
//! （没有 cargo、没有 NDK），任何不确定都要花一轮 CI 才能证伪。sidecar 的落点是
//! 确定的——Tauri 把它放在主程序**同一个目录**下、去掉 target triple 后缀——
//! 自己解析路径反而是这里最可验证的做法。

use std::io::{BufRead, BufReader};
use std::net::{TcpStream, UdpSocket};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State};

/// 服务端监听端口。固定 8080，与部署脚本、发现协议、文档全部一致。
const PORT: u16 = 8080;

#[derive(Default)]
pub struct LocalServer(pub Mutex<Option<Child>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub running: bool,
    /// 本机访问地址
    pub url: String,
    /// 同一 Wi-Fi 下别的设备该用的地址；取不到局域网 IP 时为 None
    pub lan_url: Option<String>,
}

/// sidecar 的落点：与主程序同目录。
///
/// 打包后 Tauri 会把 `ivnote-server-<target-triple>` 复制成 `ivnote-server`（Windows 带 .exe）
/// 放在主程序旁边；`tauri dev` 下则还留在 `src-tauri/binaries/`，两处都找一下。
fn sidecar_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe
        .parent()
        .ok_or_else(|| "找不到程序所在目录".to_string())?;
    let name = if cfg!(windows) {
        "ivnote-server.exe"
    } else {
        "ivnote-server"
    };
    let bundled = dir.join(name);
    if bundled.exists() {
        return Ok(bundled);
    }
    // 开发模式兜底：src-tauri/binaries/ivnote-server-<triple>
    let dev = dir
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("binaries"))
        .unwrap_or_default();
    if dev.is_dir() {
        if let Ok(rd) = std::fs::read_dir(&dev) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if n.starts_with("ivnote-server") {
                    return Ok(e.path());
                }
            }
        }
    }
    Err(format!(
        "这份安装包里没有附带同步服务端（找不到 {}）。请到项目 Releases 页下载 ivnote-server 放到程序目录，或改用远程服务器。",
        bundled.display()
    ))
}

/// 本机在局域网里的地址。
///
/// 连一个外网地址的 UDP socket 再读 `local_addr` —— UDP 是无连接的，**不会真的发包**，
/// 只是让内核按路由表挑出出口网卡。这是拿"本机对外 IP"最省事且不依赖第三方库的办法
/// （Rust 标准库没有枚举网卡的能力）。
fn lan_ip() -> Option<String> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    let ip = sock.local_addr().ok()?.ip().to_string();
    if ip.starts_with("127.") || ip == "0.0.0.0" {
        None
    } else {
        Some(ip)
    }
}

fn healthy() -> bool {
    TcpStream::connect_timeout(
        &([127, 0, 0, 1], PORT).into(),
        Duration::from_millis(300),
    )
    .is_ok()
}

fn info(running: bool) -> ServerInfo {
    ServerInfo {
        running,
        url: format!("http://127.0.0.1:{PORT}"),
        lan_url: lan_ip().map(|ip| format!("http://{ip}:{PORT}")),
    }
}

/// 启动内置服务端。
///
/// `email` / `password` 由前端生成并保存——服务端启动时会拿它们建管理员账号（幂等），
/// 前端随后用同一组凭据登录。用户因此完全不需要自己想账号密码。
#[tauri::command]
pub fn start_local_server<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LocalServer>,
    email: String,
    password: String,
) -> Result<ServerInfo, String> {
    // 已经在跑（可能是上次没关干净，也可能是用户手动起的）：直接复用，不重复拉起
    if healthy() {
        return Ok(info(true));
    }

    let exe = sidecar_path()?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("拿不到应用数据目录：{e}"))?
        .join("server");
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("创建数据目录失败：{e}"))?;

    let mut cmd = Command::new(&exe);
    cmd.env("IVNOTE_DB", "sqlite")
        .env("IVNOTE_DATA_DIR", &data_dir)
        .env("IVNOTE_LISTEN", format!(":{PORT}"))
        .env("IVNOTE_ADMIN_EMAIL", &email)
        .env("IVNOTE_ADMIN_PASSWORD", &password)
        // 开放注册保持关闭：这台服务器只服务机主自己的设备，配对码就够了
        .env("IVNOTE_OPEN_REGISTRATION", "false")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Windows：不要弹出一个黑色控制台窗口
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("启动服务端失败：{e}"))?;

    // 把子进程的 stderr 前几行留着：起不来时要能说出原因，而不是干等超时
    let mut first_errors = Vec::new();
    if let Some(err) = child.stderr.take() {
        let reader = BufReader::new(err);
        std::thread::spawn(move || {
            for line in reader.lines().map_while(Result::ok).take(50) {
                eprintln!("[ivnote-server] {line}");
            }
        });
    }

    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if healthy() {
            *state.0.lock().map_err(|_| "状态锁损坏")? = Some(child);
            return Ok(info(true));
        }
        if let Ok(Some(status)) = child.try_wait() {
            first_errors.push(format!("服务端退出，退出码 {status}"));
            return Err(first_errors.join("；"));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    let _ = child.kill();
    Err(format!(
        "服务端 20 秒内没有就绪（端口 {PORT} 可能被别的程序占用）"
    ))
}

#[tauri::command]
pub fn stop_local_server(state: State<'_, LocalServer>) -> Result<ServerInfo, String> {
    let mut guard = state.0.lock().map_err(|_| "状态锁损坏")?;
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(info(false))
}

#[tauri::command]
pub fn local_server_status(state: State<'_, LocalServer>) -> Result<ServerInfo, String> {
    // 以「端口是否可连」为准而不是以我们记着的 Child 为准：
    // 用户可能在别处（计划任务、手动双击）已经把服务端跑起来了
    let _ = state;
    Ok(info(healthy()))
}

/// 这份构建里到底有没有附带服务端。没有就不该在界面上给出那个开关。
#[tauri::command]
pub fn local_server_available() -> bool {
    sidecar_path().is_ok()
}

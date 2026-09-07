//! Windows 防火墙放行（v0.11.0）。
//!
//! # 为什么需要这个
//!
//! 用户反馈：「电脑用的网线，手机用的 WiFi 就无法同步了」。
//!
//! 内置服务端监听 `0.0.0.0:8080`（外加发现用的 UDP 9999），这两件事本身没问题，
//! 拦住手机的是 **Windows 防火墙的网络配置文件**：
//! - 无线网络在第一次连接时通常被用户点成「专用网络」，入站规则宽松；
//! - **有线网络默认落在「公用网络」**，入站一律拦截。
//!
//! 而 sidecar 是用 `CREATE_NO_WINDOW` 起的后台进程，那个「是否允许此应用通过防火墙」
//! 的弹窗要么没出现、要么被当成广告点掉了——于是"换成网线就同步不了"，
//! 而软件里从头到尾没有任何地方说得出这件事。
//!
//! 所以做两层：
//! 1. **安装时**由 NSIS 顺手写一次（见 `installer/firewall.nsh`）。注意 Tauri 的
//!    NSIS 默认是 currentUser 安装、**不提权**，所以这一步经常会失败——它是顺带的，
//!    不是保障；
//! 2. **运行时**这里能查、能补。设置里「连接诊断」会如实显示有没有规则，
//!    点一下按钮补上（走一次 UAC）。这一层才是真正兜底的那层。
//!
//! 规则按**程序**放行而不是按端口：端口放行是把 8080 对整个网络打开，
//! 谁监听都放；按程序只放行我们自己这一个 exe，权限最小。

use serde::Serialize;
#[cfg(windows)]
use std::process::Command;

/// 防火墙规则名。NSIS 安装脚本与这里必须**完全一致**，否则查不到自己写的规则。
pub const RULE_NAME: &str = "Ivyea Note Sync Server";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FirewallInfo {
    /// 这个平台需不需要（也能不能）管防火墙。非 Windows 一律 false
    pub supported: bool,
    /// 放行规则在不在
    pub allowed: bool,
    /// 说人话的现状，直接显示给用户
    pub detail: String,
}

#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

/*
 * 两个命令都是「一个薄壳 + 按平台各一份实现」，而不是在函数体里塞
 * `#[cfg(windows)] { … } #[cfg(not(windows))] { … }` 两个块。
 * 后者要靠"cfg 剥完之后剩下的那个块正好落在尾表达式位置"才成立，
 * 而这台机器编译不了 Tauri（没有 GTK 依赖），**Windows 那一支只有 CI 才编得到**——
 * 越是编译不到的代码，越该写成一眼看得出对错的形状。
 */
#[tauri::command]
pub fn firewall_status() -> FirewallInfo {
    status_impl()
}

#[cfg(windows)]
fn status_impl() -> FirewallInfo {
    let mut cmd = Command::new("netsh");
    cmd.args([
        "advfirewall",
        "firewall",
        "show",
        "rule",
        &format!("name={RULE_NAME}"),
    ]);
    no_window(&mut cmd);
    // 只看退出码，不解析输出：netsh 的输出是**本地化**的，
    // 按中文/英文去匹配字符串，换一台系统语言就失效。
    match cmd.output() {
        Ok(out) if out.status.success() => FirewallInfo {
            supported: true,
            allowed: true,
            detail: format!("已放行（规则「{RULE_NAME}」存在）"),
        },
        Ok(_) => FirewallInfo {
            supported: true,
            allowed: false,
            detail: "没有放行规则。手机连不上多半就卡在这里——有线网络在 Windows 上通常被归到「公用网络」，入站默认全拦"
                .to_string(),
        },
        Err(e) => FirewallInfo {
            supported: true,
            allowed: false,
            detail: format!("查不了防火墙状态：{e}"),
        },
    }
}

#[cfg(not(windows))]
fn status_impl() -> FirewallInfo {
    FirewallInfo {
        supported: false,
        allowed: true,
        detail: "这个系统不由本软件管理防火墙；若手机连不上，请自行放行 TCP 8080 与 UDP 9999".to_string(),
    }
}

/// 写入放行规则。需要管理员权限，所以会弹一次 UAC。
#[tauri::command]
pub fn fix_firewall() -> Result<String, String> {
    fix_impl()
}

#[cfg(windows)]
fn fix_impl() -> Result<String, String> {
    let exe = crate::localserver::sidecar_path()?;
    let path = exe.display().to_string();
    if path.contains('\'') || path.contains('"') {
        // 引号会把下面那段命令截断。宁可说清楚，也不要拼出一条半截的提权命令——
        // 那是能被利用的形状。
        return Err(
            "程序路径里含有引号，无法自动放行；请手动在「Windows 防火墙 → 允许应用」里添加".to_string(),
        );
    }
    // 先删后加：重复点不会堆出一串同名规则；删不掉（本来就没有）也不影响后面
    let script = format!(
        "netsh advfirewall firewall delete rule name=\"{RULE_NAME}\" >nul 2>&1 & \
         netsh advfirewall firewall add rule name=\"{RULE_NAME}\" dir=in action=allow \
         program=\"{path}\" enable=yes profile=any"
    );
    let command = format!(
        "Start-Process -FilePath cmd -Verb RunAs -WindowStyle Hidden -ArgumentList '/c','{script}'"
    );
    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        &command,
    ]);
    no_window(&mut cmd);
    let out = cmd.output().map_err(|e| format!("执行失败：{e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        // 用户在 UAC 上点了「否」就是这一条，不该说成"失败了"让人以为坏了
        if err.contains("canceled") || err.contains("取消") {
            return Err("已取消：没有管理员权限就写不了防火墙规则".to_string());
        }
        return Err(format!("写入防火墙规则失败：{}", err.trim()));
    }
    Ok(format!("已放行「{RULE_NAME}」"))
}

#[cfg(not(windows))]
fn fix_impl() -> Result<String, String> {
    Err("这个系统不支持自动放行防火墙".to_string())
}

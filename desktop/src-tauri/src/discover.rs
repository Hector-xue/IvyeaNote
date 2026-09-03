// v0.7.0 H9：局域网发现（Rust 侧）。
// 广播 UDP "IVYEA-DISCOVER" 到 255.255.255.255:9999，收集应答直到超时。
// 返回 [{ url, ips }]。
#[derive(serde::Serialize, Clone)]
pub struct DiscoveredServer {
    url: String,
    ips: Vec<String>,
}

#[tauri::command]
pub async fn discover_servers(timeout_ms: u64) -> Result<Vec<DiscoveredServer>, String> {
    use std::net::UdpSocket;
    use std::time::{Duration, Instant};

    let socket = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    socket.set_broadcast(true).map_err(|e| e.to_string())?;
    socket
        .send_to(b"IVYEA-DISCOVER", "255.255.255.255:9999")
        .map_err(|e| e.to_string())?;
    // 同时向本机环回探测（本机部署场景）
    let _ = socket.send_to(b"IVYEA-DISCOVER", "127.0.0.1:9999");

    socket
        .set_read_timeout(Some(Duration::from_millis(300)))
        .map_err(|e| e.to_string())?;

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut found: Vec<DiscoveredServer> = Vec::new();
    let mut buf = [0u8; 512];

    while Instant::now() < deadline {
        match socket.recv_from(&mut buf) {
            Ok((n, addr)) => {
                if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&buf[..n]) {
                    if v.get("service").and_then(|s| s.as_str()) == Some("ivyea-note") {
                        let port = match v
                            .get("port")
                            .and_then(|p| p.as_str())
                        {
                            Some(s) => s.to_string(),
                            None => v
                                .get("port")
                                .and_then(|p| p.as_i64())
                                .map(|p| p.to_string())
                                .unwrap_or_else(|| "8080".to_string()),
                        };
                        let ips: Vec<String> = v
                            .get("ips")
                            .and_then(|i| i.as_array())
                            .map(|a| {
                                a.iter()
                                    .filter_map(|x| x.as_str().map(String::from))
                                    .collect()
                            })
                            .unwrap_or_default();
                        /*
                         * 用**应答包的来源地址**当主机名，而不是应答里 `ips` 的第一项。
                         *
                         * 服务端把自己**所有**非环回 IPv4 都报了上来，顺序按网卡枚举——
                         * 一台装了 Docker Desktop / WSL / VMware / VPN 的 Windows，
                         * 第一项经常是 `172.17.0.1` 或 `192.168.56.1` 这类虚拟网卡地址，
                         * 手机永远连不上，而界面还写着"已找到"。
                         *
                         * 而这个包刚刚**真的从那个地址走到了我这里**，可达性是被证明过的。
                         * `ips` 仍然带回去，留给"这台连不上换一个试试"。
                         */
                        let host = addr.ip().to_string();
                        let url = format!("http://{}:{}", host, port);
                        if !found.iter().any(|f| f.url == url) {
                            found.push(DiscoveredServer { url, ips });
                        }
                    }
                }
            }
            Err(_) => continue, // 超时继续等剩余窗口
        }
    }
    Ok(found)
}

/**
 * 同步连接诊断（v0.11.0）。
 *
 * # 为什么要有这一块
 *
 * 用户反馈：「同步方面是个难题，电脑用的网线，手机用的 WiFi 就无法同步了」。
 *
 * 这句话里最要命的不是"连不上"，是**没人说得清卡在哪**。设置里此前只有一行
 * 「手机连同一个 Wi-Fi 就能同步」和一个地址，而真实链路上有四道关：
 *
 * 1. 服务端起没起（端口 8080 在不在听）；
 * 2. Windows 防火墙放没放行——**有线网络默认被归到「公用网络」，入站全拦**，
 *    而无线常常是「专用网络」。这正好解释了「换成网线就不行」；
 * 3. 手机填的是**哪个** IP——一台装了 Docker/WSL/VMware/VPN 的 Windows 有一堆网卡，
 *    默认路由那一个未必是手机走得通的那个（旧版只显示一个地址，就是默认路由那个）；
 * 4. 手机和电脑在不在同一个网段（路由器的 AP 隔离、访客 WiFi、双频独立子网）。
 *
 * 这个面板把四道关一次全摆出来，能修的直接给按钮，修不了的给一句能照着做的话。
 * 刻意**不**说"看起来一切正常"——我们在电脑这一侧根本证明不了手机连得上，
 * 假装能证明比不说更糟。
 */
import { useCallback, useEffect, useState } from 'react';
import { discoverServers } from '../lib/discover';
import { firewallStatus, fixFirewall, type FirewallInfo } from '../lib/firewall';
import { localServerStatus, type LocalServerInfo } from '../lib/localServer';
import { raiseToast } from './Toast';

export interface SyncDiagnosticsProps {
  /** 本机内置服务端是否已开启（外层已知，避免这里再抖一次） */
  running: boolean;
}

/** 同一网段判定：粗略按 /24 比。够用——家用网络几乎都是 /24 */
function sameSubnet(a: string, b: string): boolean {
  return a.split('.').slice(0, 3).join('.') === b.split('.').slice(0, 3).join('.');
}

export function SyncDiagnostics({ running }: SyncDiagnosticsProps) {
  const [server, setServer] = useState<LocalServerInfo | null>(null);
  const [addrs, setAddrs] = useState<string[]>([]);
  const [fw, setFw] = useState<FirewallInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [ran, setRan] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const [st, fwInfo, found] = await Promise.all([
        localServerStatus(),
        firewallStatus(),
        // 往 127.0.0.1:9999 探一下自己：服务端**自己**会报出全部非环回 IPv4，
        // 而且是按「手机最可能连得上」排过序的（虚拟网卡排最后）。
        // 这条路不需要在 Rust 里新增枚举网卡的依赖，是现成的。
        discoverServers(900),
      ]);
      setServer(st);
      setFw(fwInfo);
      const port = st?.url.split(':').pop() ?? '8080';
      const ips = found.flatMap((f) => f.ips);
      const uniq = [...new Set(ips)];
      setAddrs(uniq.map((ip) => `http://${ip}:${port}`));
    } finally {
      setBusy(false);
      setRan(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, running]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      raiseToast(`已复制 ${text}`, 'ok');
    } catch {
      raiseToast('复制失败，请手动记下来', 'error');
    }
  };

  const doFix = async () => {
    setBusy(true);
    try {
      const msg = await fixFirewall();
      raiseToast(msg, 'ok');
    } catch (e) {
      raiseToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      // 提权是异步的（UAC 弹窗 → cmd 执行），立刻查会查到旧状态
      window.setTimeout(() => void refresh(), 1500);
    }
  };

  const ips = addrs.map((u) => u.replace(/^https?:\/\//, '').split(':')[0]);
  const multiSubnet = ips.length > 1 && ips.some((ip) => !sameSubnet(ip, ips[0]));

  return (
    <div className="diag">
      <div className="diag-head">
        <strong>连接诊断</strong>
        <button className="btn ghost" disabled={busy} onClick={() => void refresh()}>
          {busy ? '检查中…' : '重新检查'}
        </button>
      </div>

      {/* 关卡 1：服务端 */}
      <div className={`diag-row ${server?.running ? 'ok' : 'bad'}`}>
        <span className="diag-dot" />
        <span className="diag-text">
          <b>同步服务</b>
          {server?.running
            ? `　正在运行（${server.url}）`
            : ran
              ? '　没有在运行。先打开上面那个「在这台电脑上开启同步」的开关'
              : '　检查中…'}
        </span>
      </div>

      {/* 关卡 2：防火墙 */}
      {fw && fw.supported && (
        <div className={`diag-row ${fw.allowed ? 'ok' : 'bad'}`}>
          <span className="diag-dot" />
          <span className="diag-text">
            <b>Windows 防火墙</b>　{fw.detail}
          </span>
          {!fw.allowed && (
            <button className="btn" disabled={busy} onClick={() => void doFix()}>
              一键放行
            </button>
          )}
        </div>
      )}

      {/* 关卡 3：手机该填哪个地址 */}
      <div className={`diag-row ${addrs.length > 0 ? 'ok' : 'bad'}`}>
        <span className="diag-dot" />
        <span className="diag-text">
          <b>这台电脑的地址</b>
          {addrs.length === 0 && (ran ? '　一个局域网地址都没拿到：这台机器可能没接入任何网络' : '　检查中…')}
        </span>
      </div>
      {addrs.length > 0 && (
        <ul className="diag-addrs">
          {addrs.map((u, i) => (
            <li key={u}>
              <code>{u}</code>
              {i === 0 && <span className="diag-tag">最可能</span>}
              <button className="link" onClick={() => void copy(u)}>
                复制
              </button>
            </li>
          ))}
        </ul>
      )}
      {multiSubnet && (
        <p className="set-hint">
          这台电脑同时挂在几个不同网段上（常见于装了 Docker / WSL / 虚拟机 / VPN）。
          手机要填的是<b>和手机同一个网段</b>的那一个——按上面的顺序从头试，
          排在前面的更可能是真正的家用网络。
        </p>
      )}

      {/* 关卡 4：网段本身 */}
      <details className="diag-more">
        <summary>手机还是连不上？按这个顺序查</summary>
        <ol className="diag-list">
          <li>
            <b>手机和电脑要在同一个路由器下。</b>电脑插网线、手机连 WiFi 完全没问题——
            只要这根网线和这个 WiFi 是同一台路由器发出来的。用手机热点、或者电脑走公司网线
            而手机连家里 WiFi，那就是两个网络，谁也找不到谁。
          </li>
          <li>
            <b>路由器的「AP 隔离 / 客户端隔离」要关掉。</b>一些路由器（尤其访客 WiFi）
            默认禁止无线设备访问其它设备，表现就是「能上网但互相看不见」。
          </li>
          <li>
            <b>双频路由器有时把 2.4G 和 5G 分成两个子网。</b>让手机连和电脑同网段的那个，
            或在路由器里打开「双频合一」。
          </li>
          <li>
            <b>在手机浏览器里直接打开上面的地址试试。</b>能看到 Ivyea Server 的状态页，
            说明网络是通的，问题在应用里；打不开就还是网络或防火墙。
          </li>
          <li>
            <b>电脑不开机时手机是同步不了的。</b>这台电脑就是服务器。要「随时随地都能同步」，
            得把服务端放在一台常开的机器上（自建服务器或轻量云主机），
            然后在「开启同步」里填那个地址。
          </li>
        </ol>
      </details>
    </div>
  );
}

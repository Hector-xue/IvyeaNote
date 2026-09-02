/**
 * 登录 / 开启同步（v0.10.3 重做）。
 *
 * 之前这一页把最难的东西摆在最前面：第一栏就是空着的「服务器地址」，
 * 底下还挂着「还没有自己的服务器？看三步部署引导」——于是「开启同步」的
 * 第一步变成了「先去搭一台服务器」，绝大多数人就停在这儿了。
 *
 * 现在的默认路径只剩两种，都不需要填地址（地址由构建期注入，见 vite.config.ts）：
 * - **配对码**：在已登录的设备上生成 6 位码，新设备输码即完成。手机默认走这条，
 *   因为在手机键盘上敲地址和密码本来就是劝退动作。
 * - **邮箱密码**：桌面默认。
 *
 * 自建服务器的人没有被牺牲：地址、连接测试、账号文件导入、部署引导，
 * 整套原样保留在「用自己的服务器」折叠区里——只是不再挡在所有人前面。
 */
import { useRef, useState } from 'react';
import { probeServer, normalizeServerUrl, isInsecurePublic, defaultServerUrl } from '../lib/serverConn';
import { claimPairCode } from '../lib/pairing';
import { discoverServers } from '../lib/discover';
import logoUrl from '../assets/logo.png';

interface Props {
  onLogin: (serverUrl: string, email: string, password: string) => Promise<void>;
  onShowGuide: () => void;
  /** 免登录模式下允许关闭登录页，直接回主界面 */
  onCancel?: () => void;
  /** v0.6.1 H6：配对码登录完成回调（注入 token） */
  onPairLogin?: (serverUrl: string, userId: number, access: string, refresh: string) => Promise<void>;
  /** 手机上默认走配对码——在手机键盘上敲地址和密码本身就是劝退动作 */
  preferPairing?: boolean;
}

/** 从「IvyeaNote-账号.txt」解析三个字段（install.sh / start.bat 生成的格式） */
export function parseAccountText(text: string): { serverUrl?: string; email?: string; password?: string } {
  const pick = (key: string) => {
    const line = text.split(/\r?\n/).find((l) => l.trim().startsWith(key));
    if (!line) return undefined;
    const iAscii = line.indexOf(':');
    const iFull = line.indexOf('：');
    const idx = iAscii >= 0 && (iFull < 0 || iAscii < iFull) ? iAscii : iFull;
    return idx >= 0 ? line.slice(idx + 1).trim() : undefined;
  };
  return {
    serverUrl: pick('服务器地址'),
    email: pick('账号'),
    password: pick('密码'),
  };
}

/** 只显示主机名：完整 URL 在这里是噪音，用户要确认的是"连的是哪家" */
export function serverLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function LoginView({ onLogin, onShowGuide, onCancel, onPairLogin, preferPairing }: Props) {
  const builtIn = defaultServerUrl();
  const [serverUrl, setServerUrl] = useState(
    () => localStorage.getItem('ivnote.server') || builtIn
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  /**
   * 方式：配对码 / 邮箱密码。
   * 没有 onPairLogin（旧调用方）时只能走密码，否则会出现一个点了没反应的标签。
   */
  const canPair = !!onPairLogin;
  const [tab, setTab] = useState<'pair' | 'password'>(
    canPair && preferPairing ? 'pair' : 'password'
  );

  /** 「用自己的服务器」折叠区。没有内置默认地址时一开始就展开——否则没地方填 */
  const [advanced, setAdvanced] = useState(!builtIn);

  /** 移动端：无法访问电脑桌面的 txt → 支持直接粘贴账号文件内容 */
  const [pasteMode, setPasteMode] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pairCode, setPairCode] = useState('');

  // v0.6.0 H3/H4：连接探测与诊断
  const [probing, setProbing] = useState(false);
  const [probeMsg, setProbeMsg] = useState<{ ok: boolean; text: string } | null>(null);

  /**
   * v0.10.5：**找找附近的电脑**。
   *
   * 服务端从 v0.7.0 起就在 UDP 9999 上应答 `IVYEA-DISCOVER` 广播，Rust 侧的
   * `discover_servers` 命令也一直都在——但**界面上从来没有任何地方在用它**
   * （跟配对码入口、免 Docker 向导一样，写了没接）。
   *
   * 对「家里一台 Windows + 一部安卓」这个主场景，这一条省掉的正是最难的一步：
   * 在手机键盘上敲 `http://192.168.x.x:8080`。
   */
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState('');

  const doScan = async () => {
    setScanMsg('');
    setError('');
    setScanning(true);
    try {
      const found = await discoverServers(2000);
      if (found.length === 0) {
        setScanMsg('没找到。请确认电脑上的 Ivyea Note 服务正在运行，且手机和电脑连的是同一个 Wi-Fi。');
        return;
      }
      const url = found[0].url;
      setServerUrl(url);
      localStorage.setItem('ivnote.server', url);
      setScanMsg(
        found.length > 1
          ? `找到 ${found.length} 台，已选中 ${serverLabel(url)}（其余可在「用自己的服务器」里手填）`
          : `已找到 ${serverLabel(url)}`
      );
    } catch (err) {
      setScanMsg(`扫描失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setScanning(false);
    }
  };

  const doProbe = async () => {
    setProbeMsg(null);
    setProbing(true);
    try {
      const r = await probeServer(serverUrl);
      setServerUrl(r.url);
      let text = r.message;
      if (r.ok && r.insecurePublic) {
        text += '｜⚠ 当前是公网 HTTP 明文连接，建议配置 HTTPS（见部署引导的 Cloudflare Tunnel 教程）';
      }
      setProbeMsg({ ok: r.ok, text });
    } finally {
      setProbing(false);
    }
  };

  /** H6: 凭服务器地址+配对码直接登录（免输账号密码） */
  const submitPair = async () => {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      if (!/^\d{6}$/.test(pairCode)) throw new Error('配对码是 6 位数字');
      const url = normalizeServerUrl(serverUrl);
      if (!url || url === 'http://' || url === 'https://') {
        throw new Error('没有服务器地址：请在下面「用自己的服务器」里填写');
      }
      const r = await claimPairCode(url, pairCode);
      localStorage.setItem('ivnote.server', url);
      // 复用登录完成链路：onLogin 只接收密码形态，这里直接走 token 注入回调
      await onPairLogin?.(url, r.userId, r.accessToken, r.refreshToken);
      setNotice('配对成功！');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (tab === 'pair') {
      void submitPair();
      return;
    }
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const url = normalizeServerUrl(serverUrl);
      if (!url || url === 'https://') {
        throw new Error('没有服务器地址：请在下面「用自己的服务器」里填写');
      }
      if (password.length < 8) throw new Error('密码至少 8 位');
      localStorage.setItem('ivnote.server', url);
      await onLogin(url, email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /** 一键导入账号文件：自动填好服务器地址 / 账号 / 密码 */
  const importAccountFile = async (f: File) => {
    setError('');
    setNotice('');
    try {
      const text = await f.text();
      const acc = parseAccountText(text);
      if (!acc.serverUrl && !acc.email && !acc.password) {
        throw new Error('没认出这个文件的内容，请选择部署生成的「IvyeaNote-账号.txt」');
      }
      if (acc.serverUrl) setServerUrl(acc.serverUrl);
      if (acc.email) setEmail(acc.email);
      if (acc.password) setPassword(acc.password);
      if (acc.serverUrl) localStorage.setItem('ivnote.server', acc.serverUrl);
      setTab('password');
      setNotice('已导入账号文件，检查无误后点「登录」即可');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <img src={logoUrl} alt="" className="login-logo" />
        <h1>开启同步</h1>
        <p className="sub">
          同步只影响"笔记能不能在多台设备之间流动"。不开也能一直用，笔记本来就在你自己手上。
        </p>

        {canPair && (
          <div className="login-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'pair'}
              className={`login-tab ${tab === 'pair' ? 'on' : ''}`}
              onClick={() => setTab('pair')}
            >
              配对码
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'password'}
              className={`login-tab ${tab === 'password' ? 'on' : ''}`}
              onClick={() => setTab('password')}
            >
              邮箱密码
            </button>
          </div>
        )}

        {tab === 'pair' ? (
          <>
            <p className="pair-how">
              在<b>已经登录过的那台设备</b>上打开「设置 → 同步 → 添加设备」，
              屏幕上会出现一个 6 位数字，60 秒内填到这里即可。
            </p>
            {!serverUrl && (
              <div className="scan-row">
                <button type="button" className="btn ghost" disabled={scanning} onClick={() => void doScan()}>
                  {scanning ? '正在找…' : '找找附近的电脑'}
                </button>
                <span className="scan-hint">和电脑连同一个 Wi-Fi 时可自动找到，不用打地址</span>
              </div>
            )}
            {scanMsg && <p className="scan-msg">{scanMsg}</p>}
            <input
              className="pair-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="000000"
              aria-label="配对码"
              value={pairCode}
              onChange={(e) => setPairCode(e.target.value.replace(/\D/g, ''))}
            />
          </>
        ) : (
          <>
            <label>
              账号
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="username"
                required
              />
            </label>
            <label>
              密码
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="至少 8 位"
                autoComplete="current-password"
                required
              />
            </label>
          </>
        )}

        {error && (
          <div className="error">
            {error}
            {/未开放注册|registration_disabled/i.test(error) && (
              <div style={{ marginTop: 6 }}>
                这台服务器没有开放注册，只有管理员建好的账号能登录。
                如果这是别人的服务器，请找管理员要账号；如果你想用自己的，
                在下面「用自己的服务器」里换成你自己的地址。
              </div>
            )}
          </div>
        )}
        {notice && <div className="notice">{notice}</div>}

        <button
          type="submit"
          className="btn primary"
          disabled={busy || (tab === 'pair' && pairCode.length !== 6)}
        >
          {busy ? '请稍候…' : tab === 'pair' ? '连接' : '登录'}
        </button>

        {onCancel && (
          <button type="button" className="btn ghost" onClick={onCancel}>
            先不同步，直接记笔记 →
          </button>
        )}

        {/* 连的是哪台服务器要一眼看得见——但不该占着第一栏 */}
        <div className="server-line">
          <span className="server-cur">
            {serverUrl ? (
              <>
                同步到 <b>{serverLabel(normalizeServerUrl(serverUrl))}</b>
              </>
            ) : (
              <>还没有服务器地址</>
            )}
          </span>
          <button type="button" className="link" onClick={() => setAdvanced((v) => !v)}>
            {advanced ? '收起' : '用自己的服务器'}
          </button>
        </div>

        {advanced && (
          <div className="login-advanced">
            <label>
              服务器地址
              <input
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="本机部署填 http://127.0.0.1:8080"
                autoComplete="url"
              />
            </label>
            <div className="probe-row">
              <button
                type="button"
                className="btn ghost"
                disabled={probing || !serverUrl.trim()}
                onClick={() => void doProbe()}
              >
                {probing ? '测试中…' : '测试连接'}
              </button>
              {probeMsg && <span className={probeMsg.ok ? 'probe-ok' : 'probe-fail'}>{probeMsg.text}</span>}
            </div>
            {serverUrl && isInsecurePublic(normalizeServerUrl(serverUrl)) && (
              <div className="warn-hint">
                ⚠ 公网 HTTP 明文连接有被窃听风险，推荐配置 HTTPS（Cloudflare Tunnel，免费）
              </div>
            )}

            <button type="button" className="btn ghost import-btn" onClick={() => fileRef.current?.click()}>
              导入账号文件（IvyeaNote-账号.txt）
            </button>
            <button type="button" className="link paste-toggle" onClick={() => setPasteMode((v) => !v)}>
              手机上？点此粘贴账号内容
            </button>
            {pasteMode && (
              <>
                <textarea
                  className="paste-box"
                  rows={5}
                  placeholder={'把电脑桌面「IvyeaNote-账号.txt」的内容整段粘贴到这里\n（微信/QQ 发给自己即可传输）'}
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                />
                <button
                  type="button"
                  className="btn ghost import-btn"
                  onClick={() => {
                    const acc = parseAccountText(pasteText);
                    if (!acc.serverUrl && !acc.email && !acc.password) {
                      setError('没认出粘贴的内容，请粘贴完整的账号文件文本');
                      return;
                    }
                    if (acc.serverUrl) {
                      setServerUrl(acc.serverUrl);
                      localStorage.setItem('ivnote.server', acc.serverUrl);
                    }
                    if (acc.email) setEmail(acc.email);
                    if (acc.password) setPassword(acc.password);
                    setTab('password');
                    setError('');
                    setNotice('已从粘贴内容填好，检查无误后点「登录」');
                  }}
                >
                  解析并填充
                </button>
              </>
            )}
            <p className="hint">
              想把笔记存在自己的机器上？
              <button type="button" className="link" onClick={onShowGuide}>
                看三步部署引导
              </button>
            </p>
          </div>
        )}

        <input
          ref={fileRef}
          type="file"
          accept=".txt,text/plain"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importAccountFile(f);
            e.target.value = '';
          }}
        />
      </form>
    </div>
  );
}

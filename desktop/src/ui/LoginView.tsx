import { useRef, useState } from 'react';
import { probeServer, normalizeServerUrl, isInsecurePublic } from '../lib/serverConn';
import { claimPairCode } from '../lib/pairing';
import logoUrl from '../assets/logo.svg';

interface Props {
  onLogin: (serverUrl: string, email: string, password: string) => Promise<void>;
  onShowGuide: () => void;
  /** 免登录模式下允许关闭登录页，直接回主界面 */
  onCancel?: () => void;
  /** v0.6.1 H6：配对码登录完成回调（注入 token） */
  onPairLogin?: (serverUrl: string, userId: number, access: string, refresh: string) => Promise<void>;
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

export function LoginView({ onLogin, onShowGuide, onCancel, onPairLogin }: Props) {
  const [serverUrl, setServerUrl] = useState(() => localStorage.getItem('ivnote.server') || '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  /** 移动端：无法访问电脑桌面的 txt → 支持直接粘贴账号文件内容 */
  const [pasteMode, setPasteMode] = useState(false);
  const [pasteText, setPasteText] = useState('');
  // v0.6.1 H6: pairing quick-connect
  const [pairMode, setPairMode] = useState(false);
  const [pairCode, setPairCode] = useState('');

  // v0.6.0 H3/H4：连接探测与诊断
  const [probing, setProbing] = useState(false);
  const [probeMsg, setProbeMsg] = useState<{ ok: boolean; text: string } | null>(null);

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
    if (!/\d{6}/.test(pairCode)) throw new Error('配对码是 6 位数字');
    const url = normalizeServerUrl(serverUrl);
    if (!url || url === 'http://' || url === 'https://') throw new Error('请先填服务器地址');
    setBusy(true);
    try {
      const r = await claimPairCode(url, pairCode);
      localStorage.setItem('ivnote.server', url);
      // 复用登录完成链路：onLogin 只接收密码形态，这里直接走 token 注入回调
      await onPairLogin?.(url, r.userId, r.accessToken, r.refreshToken);
      setNotice('配对成功！');
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const url = normalizeServerUrl(serverUrl);
      if (!url || url === 'https://') throw new Error('请填写你的服务器地址');
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
      setNotice('已导入账号文件，检查无误后点「登录」即可');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <img src={logoUrl} alt="" className="login-logo" />
        <h1>
          Ivyea <span>Note</span>
        </h1>
        <p className="sub">自托管 Markdown 笔记 · 数据完全属于你</p>

        <button type="button" className="btn ghost import-btn" onClick={() => fileRef.current?.click()}>
          导入账号文件（桌面上的 IvyeaNote-账号.txt）
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
                setError('');
                setNotice('已从粘贴内容填好，检查无误后点「登录」');
              }}
            >
              解析并填充
            </button>
          </>
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

        <label>
          服务器地址
          <input
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder="本机部署填 http://127.0.0.1:8080"
            autoComplete="url"
            required
          />
        </label>
        <div className="probe-row">
          <button type="button" className="btn ghost" disabled={probing || !serverUrl.trim()} onClick={() => void doProbe()}>
            {probing ? '测试中…' : '测试连接'}
          </button>
          {probeMsg && (
            <span className={probeMsg.ok ? 'probe-ok' : 'probe-fail'}>{probeMsg.text}</span>
          )}
        </div>
        {serverUrl && isInsecurePublic(normalizeServerUrl(serverUrl)) && (
          <div className="warn-hint">⚠ 公网 HTTP 明文连接有被窃听风险，推荐配置 HTTPS（Cloudflare Tunnel，免费）</div>
        )}
        <label>
          账号
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="admin@example.com"
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

        {onPairLogin && (
          <>
            <button type="button" className="link paste-toggle" onClick={() => setPairMode((v) => !v)}>
              已有配对码？免密码快速登录
            </button>
            {pairMode && (
              <div className="pair-row">
                <input
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="6 位配对码"
                  value={pairCode}
                  onChange={(e) => setPairCode(e.target.value.replace(/\D/g, ''))}
                />
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy || pairCode.length !== 6}
                  onClick={() => void submitPair()}
                >
                  配对登录
                </button>
              </div>
            )}
          </>
        )}

        {error && (
          <div className="error">
            {error}
            {/未开放注册|registration_disabled/i.test(error) && (
              <div style={{ marginTop: 6 }}>
                自托管默认只允许管理员账号登录。账号密码在你部署后桌面生成的
                「IvyeaNote-账号.txt」里；如需开放注册，在服务端 .env 设置
                IVNOTE_OPEN_REGISTRATION=true 后重启服务。
              </div>
            )}
          </div>
        )}
        {notice && <div className="notice">{notice}</div>}

        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? '请稍候…' : '登录'}
        </button>

        {onCancel && (
          <button type="button" className="btn ghost" onClick={onCancel}>
            先不登录，直接记笔记 →
          </button>
        )}

        <p className="hint">
          账号密码在你部署后自动生成的「IvyeaNote-账号.txt」里；
          <br />
          还没有自己的服务器？
          <button type="button" className="link" onClick={onShowGuide}>
            看三步部署引导
          </button>
        </p>
      </form>
    </div>
  );
}

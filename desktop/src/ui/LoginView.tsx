import { useRef, useState } from 'react';
import logoUrl from '../assets/logo.svg';

interface Props {
  onLogin: (serverUrl: string, email: string, password: string) => Promise<void>;
  onShowGuide: () => void;
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

export function LoginView({ onLogin, onShowGuide }: Props) {
  const [serverUrl, setServerUrl] = useState(() => localStorage.getItem('ivnote.server') || '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      let url = serverUrl.trim().replace(/\/+$/, '');
      if (!/^https?:\/\//.test(url)) url = `https://${url}`;
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
          📄 导入账号文件（桌面上的 IvyeaNote-账号.txt）
        </button>
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

        {error && <div className="error">{error}</div>}
        {notice && <div className="notice">{notice}</div>}

        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? '请稍候…' : '登录'}
        </button>

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

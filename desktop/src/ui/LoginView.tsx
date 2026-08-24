import { useState } from 'react';
import logoUrl from '../assets/logo.svg';

interface Props {
  onLogin: (serverUrl: string, email: string, password: string) => Promise<void>;
}

export function LoginView({ onLogin }: Props) {
  const [serverUrl, setServerUrl] = useState(() => localStorage.getItem('ivnote.server') || '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      let url = serverUrl.trim().replace(/\/+$/, '');
      if (!/^https?:\/\//.test(url)) url = `https://${url}`;
      if (!url) throw new Error('请填写你的服务器地址');
      if (password.length < 8) throw new Error('密码至少 8 位');
      localStorage.setItem('ivnote.server', url);
      await onLogin(url, email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
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

        <label>
          服务器地址
          <input
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder="例如 https://notes.example.com"
            autoComplete="url"
            required
          />
        </label>
        <label>
          账号（部署时在服务端 .env 配置）
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

        <button type="submit" disabled={busy}>
          {busy ? '请稍候…' : '登录'}
        </button>
        <p className="hint">
          没有账号？本服务为自托管模式，账号由部署者在服务端配置；
          <br />
          首次启动未设密码时会自动生成随机密码并打印在容器日志中。
        </p>
      </form>
    </div>
  );
}

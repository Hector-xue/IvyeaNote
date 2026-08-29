/**
 * 设置 → 同步 → Agent 接入（P3 收尾，v0.9.0）。
 *
 * 服务端 v0.8.8/v0.8.9 已经把 MCP 端点做完了，但签发令牌只能 curl——
 * **功能在、用不了**。这一块把它搬进界面。
 *
 * 一条硬约束决定了这里的交互：**令牌明文只在签发那一次的响应里出现**
 * （服务端只存 sha256）。所以不能像别的设置那样「保存了回头再看」，
 * 必须当场把明文摆出来、给一个复制按钮、并明说关掉就没了。
 */
import { useCallback, useEffect, useState } from 'react';
import type { McpTokenInfo, SyncClient } from '../lib/api';

interface Props {
  client: SyncClient | null;
  /** 服务器地址，用来拼出给用户抄的 MCP URL */
  serverUrl: string | null;
  toast(msg: string, kind: 'ok' | 'error'): void;
  errText(e: unknown): string;
}

function fmt(ts?: string): string {
  if (!ts) return '还没用过';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

/** 服务器地址 → MCP 端点。地址里可能带/不带结尾斜杠，两种都得对 */
export function mcpEndpoint(serverUrl: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/mcp`;
}

export function AgentSection(props: Props) {
  const { client, toast, errText } = props;
  const [tokens, setTokens] = useState<McpTokenInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('ivyea-agent');
  /** 刚签发出来的明文。只在内存里，刷新即失 —— 和服务端的语义一致 */
  const [fresh, setFresh] = useState<{ token: string; name: string } | null>(null);

  const reload = useCallback(async () => {
    if (!client) return;
    try {
      setTokens((await client.listMcpTokens()).tokens);
    } catch (e) {
      toast(`读取令牌失败：${errText(e)}`, 'error');
    }
  }, [client, toast, errText]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = async () => {
    if (!client || busy) return;
    setBusy(true);
    try {
      const r = await client.createMcpToken(name.trim() || '未命名');
      setFresh({ token: r.token, name: r.name });
      await reload();
    } catch (e) {
      toast(`签发失败：${errText(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (t: McpTokenInfo) => {
    if (!client) return;
    try {
      await client.deleteMcpToken(t.id);
      toast(`已撤销「${t.name}」`, 'ok');
      await reload();
    } catch (e) {
      toast(`撤销失败：${errText(e)}`, 'error');
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制', 'ok');
    } catch {
      // 剪贴板在部分 WebView 里不可用；退回让用户手动选中
      toast('复制失败，请手动选中上面那串', 'error');
    }
  };

  if (!client) {
    return (
      <p className="set-hint">
        登录同步后，这里可以签发给 IvyeaAgent 用的长期令牌，让它读你的笔记、把产出写回来。
      </p>
    );
  }

  return (
    <>
      <p className="set-hint">
        给 IvyeaAgent 签一张长期令牌，它就能读你的笔记、把周报和巡检结果写进
        <code>Agent/</code> 目录，手机上打开就能看。配置方法见仓库里的
        <code>docs/Agent接入-MCP.md</code>。
      </p>

      {props.serverUrl && (
        <div className="set-row set-about">
          <span className="set-label">
            MCP 端点
            <span className="set-hint">{mcpEndpoint(props.serverUrl)}</span>
          </span>
          <button className="btn" onClick={() => void copy(mcpEndpoint(props.serverUrl!))}>
            复制
          </button>
        </div>
      )}

      {/* 明文只出现这一次，所以它必须是这块里最显眼的东西 */}
      {fresh && (
        <div className="token-fresh">
          <div className="token-fresh-head">
            「{fresh.name}」已签发 —— <b>这串只显示这一次</b>
          </div>
          <code className="token-value">{fresh.token}</code>
          <div className="token-fresh-actions">
            <button className="btn primary" onClick={() => void copy(fresh.token)}>
              复制令牌
            </button>
            <button className="btn ghost" onClick={() => setFresh(null)}>
              我已保存
            </button>
          </div>
          <p className="set-hint">
            关掉之后服务端也拿不出来（只存了哈希）。丢了就撤销这张、重新签一张。
          </p>
        </div>
      )}

      <div className="set-row">
        <label className="set-label">
          新令牌名称
          <span className="set-hint">给自己看的，比如「服务器上的 agent」</span>
        </label>
        <div className="token-new">
          <input
            className="set-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ivyea-agent"
          />
          <button className="btn primary" disabled={busy} onClick={() => void create()}>
            {busy ? '签发中…' : '签发'}
          </button>
        </div>
      </div>

      {tokens !== null && tokens.length > 0 && (
        <ul className="token-list">
          {tokens.map((t) => (
            <li key={t.id}>
              <span className="token-name">{t.name}</span>
              <span className="token-meta">
                {t.prefix}… · 最近使用 {fmt(t.last_used_at)}
              </span>
              <button className="btn ghost danger" onClick={() => void revoke(t)}>
                撤销
              </button>
            </li>
          ))}
        </ul>
      )}
      {tokens !== null && tokens.length === 0 && (
        <p className="set-hint">还没有签发过令牌。</p>
      )}
    </>
  );
}

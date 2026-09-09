/**
 * 大模型这一层最容易出的不是"接口调不通"，而是**默默把用户的文字改坏**：
 * 地址拼错、把模型的开场白当正文写进笔记、错误信息只有一句 TypeError。
 * 所以测的是这几件事，而不是去真的调一次接口。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  chatUrl,
  cleanReply,
  isLlmConfigured,
  streamChat,
  LlmError,
  AI_ACTIONS,
  buildMessages,
  customSpec,
  askNoteSpec,
  askVaultSpec,
  buildVaultContext,
} from './llm';

afterEach(() => vi.restoreAllMocks());

/** 造一个 SSE 响应体 */
function sse(chunks: string[]): Response {
  const body = new ReadableStream({
    start(c) {
      for (const t of chunks) {
        c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`));
      }
      c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  return new Response(body, { status: 200 });
}

describe('接口地址拼接', () => {
  it('裸域名补 /v1/chat/completions', () => {
    expect(chatUrl('https://api.example.com')).toBe('https://api.example.com/v1/chat/completions');
    expect(chatUrl('https://api.example.com/')).toBe('https://api.example.com/v1/chat/completions');
  });
  it('已经带 /v1 的只补后半段（用户填哪种都能用）', () => {
    expect(chatUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1/chat/completions');
  });
  it('已经是完整端点的原样用', () => {
    const full = 'https://api.example.com/v1/chat/completions';
    expect(chatUrl(full)).toBe(full);
  });
});

describe('流式解析', () => {
  it('把增量拼成完整文本，并逐段回调', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse(['修正', '后的', '文字'])));
    const seen: string[] = [];
    const out = await streamChat(
      { baseUrl: 'https://x.test', apiKey: 'k', model: 'm' },
      [{ role: 'user', content: '原文' }],
      (d) => seen.push(d)
    );
    expect(out).toBe('修正后的文字');
    expect(seen).toEqual(['修正', '后的', '文字']);
  });

  it('半帧不会把解析打断（网络分片是常态）', async () => {
    const body = new ReadableStream({
      start(c) {
        const enc = new TextEncoder();
        const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: '甲乙' } }] })}\n\n`;
        c.enqueue(enc.encode(frame.slice(0, 12)));
        c.enqueue(enc.encode(frame.slice(12)));
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
    const out = await streamChat({ baseUrl: 'https://x.test', apiKey: '', model: 'm' }, []);
    expect(out).toBe('甲乙');
  });
});

describe('失败要说人话', () => {
  const call = () => streamChat({ baseUrl: 'https://x.test', apiKey: 'k', model: 'm' }, []);

  it('401 指向 API Key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    await expect(call()).rejects.toThrow(/API Key/);
  });
  it('404 指向接口地址', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    await expect(call()).rejects.toThrow(/接口地址/);
  });
  it('429 说清是限流', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('slow down', { status: 429 })));
    await expect(call()).rejects.toThrow(/限流/);
  });
  it('连不上时不抛裸 TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(call()).rejects.toBeInstanceOf(LlmError);
    await expect(call()).rejects.toThrow(/连不上接口/);
  });
});

describe('回复清洗与动作定义', () => {
  it('整段被围栏包住时脱掉围栏', () => {
    expect(cleanReply('```markdown\n# 标题\n正文\n```')).toBe('# 标题\n正文');
  });
  it('正文里本来就有代码块时不动它', () => {
    const t = '说明\n\n```js\nconst a = 1;\n```\n\n结尾';
    expect(cleanReply(t)).toBe(t);
  });
  it('没配置好就不算配置好（缺 model 或 baseUrl）', () => {
    expect(isLlmConfigured({ baseUrl: '', apiKey: '', model: 'm' })).toBe(false);
    expect(isLlmConfigured({ baseUrl: 'https://x', apiKey: '', model: '' })).toBe(false);
    // apiKey 允许为空：本地 Ollama / LM Studio 不需要
    expect(isLlmConfigured({ baseUrl: 'https://x', apiKey: '', model: 'm' })).toBe(true);
  });
  it('每个动作都说得清"会不会覆盖原文"', () => {
    for (const a of AI_ACTIONS) {
      expect(a.mode === 'replace' || a.mode === 'produce').toBe(true);
      expect(a.system.length).toBeGreaterThan(20);
    }
    const msgs = buildMessages(AI_ACTIONS[0], '原文');
    expect(msgs[0].role).toBe('system');
    expect(msgs[1]).toEqual({ role: 'user', content: '原文' });
  });
});

/**
 * 临时动作（v0.11.20）：自定义指令与两种提问。
 *
 * 这三条不在 AI_ACTIONS 里，是**按用户当场说的话现造**的。要锁死的是：
 * 指令进得了提示词、模式选得对（会不会覆盖原文）、以及问答那两条**必须**
 * 带上"答不上来就说答不上来"——笔记问答里最坏的结果不是没答案，
 * 而是编一个看起来像自己写过的答案。
 */
describe('自定义指令与提问', () => {
  it('用户说的那句话进了提示词', () => {
    const spec = customSpec('改成给客户看的口吻', 'replace');
    expect(spec.system).toContain('改成给客户看的口吻');
    expect(spec.mode).toBe('replace');
  });

  it('没有选区时是产出模式——"替换整篇"这种事不做', () => {
    expect(customSpec('随便改改', 'produce').mode).toBe('produce');
  });

  it('提示词太长时 hint 截断，菜单里不会撑成一整行', () => {
    const spec = customSpec('一'.repeat(80), 'replace');
    expect(spec.hint.length).toBeLessThanOrEqual(25);
  });

  it('问一篇：只准用给出的内容，答不上来要直说', () => {
    const spec = askNoteSpec('我最后定的方案是什么');
    expect(spec.mode).toBe('produce');
    expect(spec.system).toContain('我最后定的方案是什么');
    expect(spec.system).toContain('没有提到');
  });

  it('问全库：必须标出处——没有出处的全库问答等于随口一说', () => {
    const spec = askVaultSpec('定价结论');
    expect(spec.system).toContain('[[');
    expect(spec.system).toContain('出处');
  });

  it('片段拼起来时每段都带自己的出处', () => {
    const ctx = buildVaultContext([
      { path: 'a/b.md', text: '第一段' },
      { path: 'c.md', text: '第二段' },
    ]);
    expect(ctx).toContain('【出处：a/b.md】');
    expect(ctx).toContain('【出处：c.md】');
    expect(ctx.indexOf('第一段')).toBeLessThan(ctx.indexOf('第二段'));
  });
});

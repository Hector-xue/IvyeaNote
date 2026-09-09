/**
 * OpenAI 兼容的大模型客户端（v0.11.18）。
 *
 * 与 ivyea-translate 同一套配置形状：`base_url` + `api_key` + `model` 三件套，
 * 任何兼容 `/v1/chat/completions` 的服务都能用（官方、中转、本地 Ollama/LM Studio）。
 * 不引任何 SDK：一个 `fetch` + 一段 SSE 解析就够了，省下一整棵依赖树。
 *
 * # 这一层只负责"把文本送出去、把文本收回来"
 *
 * 三条边界，写在这里免得后面越界：
 *
 * 1. **只发给它该看的那点内容。** 调用方传什么它就发什么——默认是**选中的文本**，
 *    不是整篇笔记。笔记软件把整个库喂给第三方接口是不可接受的默认行为。
 * 2. **不落盘。** 这里只返回字符串，写不写进笔记由上层在用户确认之后决定。
 * 3. **失败要说人话。** 401 是 key 不对、404 多半是 base_url 少了 `/v1`、
 *    连不上是网络或地址错——直接把这几句给用户，比抛一个 `TypeError` 强。
 */

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 0~1，越低越稳。校对/改写这类活默认低温 */
  temperature?: number;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status = 0
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export function isLlmConfigured(c: Partial<LlmConfig> | null | undefined): c is LlmConfig {
  return !!(c && c.baseUrl?.trim() && c.model?.trim());
}

/** `https://api.example.com` → `…/v1/chat/completions`；已经带路径的原样用 */
export function chatUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/v\d+$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 把 HTTP 状态翻译成一句能照着做的话 */
function explain(status: number, body: string): string {
  const brief = body.trim().slice(0, 200);
  if (status === 401 || status === 403) return `接口拒绝了这个 API Key（${status}）。检查 Key 是否正确、是否过期`;
  if (status === 404) return `接口地址不对（404）。多数是 base_url 少了或多了 /v1：${brief}`;
  if (status === 429) return '被限流了（429）。稍等一会儿再试，或换一个额度充足的 Key';
  if (status >= 500) return `服务端出错（${status}）。多半不是你这边的问题，过一会儿再试`;
  return `请求失败（${status}）：${brief}`;
}

/**
 * 流式对话。每收到一段增量就回调一次；返回完整文本。
 *
 * 用流式不是为了炫技：校对一段长文要十几秒，没有流式的话按钮会像卡死。
 * `signal` 让上层能随时取消——用户改主意了不该还在烧 token。
 */
export async function streamChat(
  cfg: LlmConfig,
  messages: ChatMessage[],
  onDelta?: (chunk: string) => void,
  signal?: AbortSignal
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(chatUrl(cfg.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.apiKey.trim() ? { authorization: `Bearer ${cfg.apiKey.trim()}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: cfg.temperature ?? 0.2,
        stream: true,
      }),
      signal,
    });
  } catch (e) {
    // fetch 直接抛 = 请求压根没发出去：地址错、断网、或被拦
    throw new LlmError(`连不上接口（${e instanceof Error ? e.message : String(e)}）。检查接口地址与网络`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new LlmError(explain(res.status, body), res.status);
  }
  if (!res.body) throw new LlmError('接口没有返回内容');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE：按空行分帧，每帧若干 `data:` 行
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return out;
      try {
        const json = JSON.parse(payload) as {
          choices?: { delta?: { content?: string }; message?: { content?: string } }[];
        };
        const delta = json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.message?.content ?? '';
        if (delta) {
          out += delta;
          onDelta?.(delta);
        }
      } catch {
        /* 半帧或心跳行：等下一段拼上再解析 */
      }
    }
  }
  return out;
}

/** 非流式：一次拿完整回复（连通性测试这类短请求用） */
export async function chat(cfg: LlmConfig, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  return streamChat(cfg, messages, undefined, signal);
}

/** 连通性测试：让模型回一个词。成功返回它说了什么，失败抛 LlmError */
export async function testConnection(cfg: LlmConfig): Promise<string> {
  const reply = await chat(cfg, [
    { role: 'system', content: '你是连通性探针。只回复两个字：可用' },
    { role: 'user', content: 'ping' },
  ]);
  if (!reply.trim()) throw new LlmError('接口通了，但返回的是空内容（检查模型名是否正确）');
  return reply.trim();
}

// ---------------------------------------------------------------- 动作

export type AiAction = 'proofread' | 'polish' | 'concise' | 'formal' | 'structure' | 'summarize' | 'title';

export interface AiActionSpec {
  id: AiAction;
  label: string;
  hint: string;
  /** 结果是"替换选中文本"还是"给一段新东西"（后者不会覆盖原文） */
  mode: 'replace' | 'produce';
  system: string;
}

/*
 * 提示词写得直白且**限制死输出形状**：这些动作的结果要直接替换用户的文字，
 * 模型多说一句"好的，这是修改后的版本"就会被写进笔记里。
 * 所有替换类动作都反复强调：只输出正文本身、保持 Markdown 结构、不要解释。
 */
const KEEP = '只输出处理后的正文本身，不要任何前言、解释或代码围栏。保持原有的 Markdown 结构（标题层级、列表、表格、代码块、链接）不变。';

export const AI_ACTIONS: AiActionSpec[] = [
  {
    id: 'proofread',
    label: '校对',
    hint: '改错别字、病句、标点，不改写风格',
    mode: 'replace',
    system: `你是中文校对。修正错别字、语法错误、标点误用与明显的重复啰嗦，**不改变作者的语气与措辞风格**，不增删观点。${KEEP}`,
  },
  {
    id: 'polish',
    label: '润色',
    hint: '让它更通顺自然，保留原意',
    mode: 'replace',
    system: `你是中文编辑。让文字更通顺自然、去掉翻译腔与冗余，保留作者的原意与语气。不要拔高，不要加没有的信息。${KEEP}`,
  },
  {
    id: 'concise',
    label: '精简',
    hint: '砍掉水分，信息一条不少',
    mode: 'replace',
    system: `你是中文编辑。在**不丢任何信息**的前提下把文字压短：删重复、删客套、把长句拆短。${KEEP}`,
  },
  {
    id: 'formal',
    label: '更正式',
    hint: '书面语，适合对外发的材料',
    mode: 'replace',
    system: `你是中文编辑。把文字改写为书面、正式的表达，适合对外发布的材料。不改变事实与结论。${KEEP}`,
  },
  {
    id: 'structure',
    label: '整理成结构',
    hint: '口水话 → 标题、列表、表格',
    mode: 'replace',
    system: `你是中文编辑。把这段零散的文字整理成结构化的 Markdown：该分点的分点、该做表的做表、该加小标题的加小标题。**不要新增原文没有的信息**。只输出 Markdown 正文本身，不要前言与解释。`,
  },
  {
    id: 'summarize',
    label: '写摘要',
    hint: '三到五句，附在文末',
    mode: 'produce',
    system: '你是中文编辑。用三到五句话概括这段内容的要点，直接输出摘要本身，不要前言。',
  },
  {
    id: 'title',
    label: '起标题',
    hint: '给三个候选',
    mode: 'produce',
    system: '你是中文编辑。为这段内容拟三个标题候选，每行一个，不要编号、不要解释、不要引号。',
  },
];

/** 拼一次动作的消息。文本永远走 user 角色，system 只放指令 */
export function buildMessages(spec: AiActionSpec, text: string): ChatMessage[] {
  return [
    { role: 'system', content: spec.system },
    { role: 'user', content: text },
  ];
}

/**
 * 模型有时不听话，还是会套一层围栏或加一句开场白。这里做最后一道清洗——
 * 只清"整段被围栏包起来"这种明确情况，不猜别的，猜错就等于篡改用户的文字。
 */
export function cleanReply(reply: string): string {
  const t = reply.trim();
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(t);
  return (fenced ? fenced[1] : t).trim();
}

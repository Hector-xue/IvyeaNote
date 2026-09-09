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

export type AiAction =
  | 'proofread'
  | 'polish'
  | 'concise'
  | 'formal'
  | 'structure'
  | 'expand'
  | 'translate-en'
  | 'translate-zh'
  | 'summarize'
  | 'title'
  | 'todos'
  | 'tags';

export interface AiActionSpec {
  /** 内置动作是 AiAction；用户自定义与"问一句"这类临时动作是自己造的 id */
  id: string;
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
    id: 'expand',
    label: '扩写',
    hint: '把要点铺成完整段落',
    mode: 'replace',
    system: `你是中文编辑。把这段提纲式的要点铺开成完整、连贯的段落，补上必要的过渡与说明。**不要引入原文没有的事实、数字或结论**——展开的是表达，不是内容。${KEEP}`,
  },
  {
    id: 'translate-en',
    label: '译成英文',
    hint: '保持 Markdown 结构',
    mode: 'replace',
    system: `你是中英译者。把这段内容翻译成自然的英文，保持原有的 Markdown 结构。专有名词、代码、链接地址、行内代码保持原样不译。${KEEP}`,
  },
  {
    id: 'translate-zh',
    label: '译成中文',
    hint: '保持 Markdown 结构',
    mode: 'replace',
    system: `你是英中译者。把这段内容翻译成自然的中文（不要翻译腔），保持原有的 Markdown 结构。专有名词、代码、链接地址、行内代码保持原样不译。${KEEP}`,
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
  {
    id: 'todos',
    label: '提取待办',
    hint: '会议记录 → 勾选清单',
    mode: 'produce',
    system:
      '从这段内容里找出所有"要做的事"，输出 Markdown 待办清单，每行形如 `- [ ] 事项`。' +
      '只列文中确实提到的事，**不要发挥**；能看出负责人或时间的就写在事项里。一件都没有就回复"没有找到待办"。',
  },
  {
    id: 'tags',
    label: '生成标签',
    hint: '三到五个，附在文末',
    mode: 'produce',
    system:
      '为这篇笔记拟 3~5 个标签，用于以后检索。只输出一行，形如 `#标签一 #标签二 #标签三`。' +
      '标签要具体（用领域词、项目名、方法名），不要「笔记」「记录」「其他」这类没有区分度的词。不要解释。',
  },
];

// ------------------------------------------------- 临时动作（指令 / 提问）

/**
 * **自定义指令**：用户自己说一句要怎么处理这段文字。
 *
 * 内置那十二条动作再多也盖不全人的需求——「改成给客户看的口吻」「把人名换成代号」
 * 「按时间重排」，这类一次性的活只能由用户自己说。所以留这一条：
 * 一个动作等于无数动作。
 *
 * 有选中文字时是**替换**（改的是这一段），没有选中时是**产出**（结果附到文末），
 * 因为"没选中还要替换"只能意味着替换整篇——那是把用户的笔记交给一次不可见的调用，
 * 这个软件不做这种事。
 */
export function customSpec(instruction: string, mode: 'replace' | 'produce'): AiActionSpec {
  const tail =
    mode === 'replace'
      ? KEEP
      : '直接输出结果本身，不要前言与解释。';
  return {
    id: 'custom',
    label: '自定义指令',
    hint: instruction.length > 24 ? `${instruction.slice(0, 24)}…` : instruction,
    mode,
    system: `你是中文写作助手。按用户的要求处理下面这段内容。用户的要求是：「${instruction}」。${tail}`,
  };
}

/**
 * **问这篇笔记**：答案只许来自这篇笔记。
 *
 * 关键是最后那句"资料里没有就直说"。笔记问答里最坏的结果不是答不上来，
 * 而是**编一个看起来像自己写过的答案**——用户会当成自己的旧结论用出去。
 */
export function askNoteSpec(question: string): AiActionSpec {
  return {
    id: 'ask-note',
    label: '问这篇笔记',
    hint: question.length > 24 ? `${question.slice(0, 24)}…` : question,
    mode: 'produce',
    system:
      `根据用户给出的笔记内容回答这个问题：「${question}」。` +
      '只依据给出的内容回答，**不要用你自己的知识补充**。笔记里没有写到的，就直说"这篇笔记里没有提到"。' +
      '回答简明，需要时可以引用原文里的原句。',
  };
}

/**
 * **问整个笔记库**：答案只许来自检索到的那几段，而且必须标出处。
 *
 * 出处不是装饰——它是用户唯一能核对的东西。没有出处的全库问答，
 * 和"随便说一个听起来像你写过的答案"没有区别。
 */
export function askVaultSpec(question: string): AiActionSpec {
  return {
    id: 'ask-vault',
    label: '问整个笔记库',
    hint: question.length > 24 ? `${question.slice(0, 24)}…` : question,
    mode: 'produce',
    system:
      `根据用户给出的若干篇笔记片段回答这个问题：「${question}」。` +
      '每一段前面有 `【出处：路径】`。**只依据这些片段回答**，不要用你自己的知识补充。' +
      '答案里凡是有依据的地方，都要在句末标出处，写成 `[[路径]]`（去掉 .md 后缀）。' +
      '片段里找不到答案就直说"这些笔记里没有提到"，并说明你查到的最接近的是哪几篇。',
  };
}

/**
 * **存下来的自定义动作**：同一句指令用第二次，就不该再打一遍。
 *
 * 存的是**指令**，不是提示词工程——用户写的那句话原样进 `customSpec`，
 * 所见即所得。`id` 前缀 `saved:` 是为了和内置动作永远不撞。
 */
export function savedSpec(saved: { id: string; label: string; instruction: string; mode: 'replace' | 'produce' }): AiActionSpec {
  const base = customSpec(saved.instruction, saved.mode);
  return { ...base, id: `saved:${saved.id}`, label: saved.label, hint: base.hint };
}

/**
 * **今天 / 这周写了什么**：把这段时间动过的笔记，总结成一段能贴进日记的话。
 *
 * 日记写不下去的真实原因是想不起来白天动了什么，而这件事机器全知道（mtime）。
 * 所以要求它**只根据给出的片段说事**，并把涉及的笔记标成 `[[路径]]`——
 * 日记的价值在于第二天点得回去。
 */
export function recapSpec(range: 'day' | 'week'): AiActionSpec {
  const word = range === 'day' ? '今天' : '最近一周';
  return {
    id: range === 'day' ? 'recap-day' : 'recap-week',
    label: range === 'day' ? '今天写了什么' : '本周写了什么',
    hint: '按改动过的笔记summarize成日记',
    mode: 'produce',
    system:
      `下面是用户${word}改动过的若干篇笔记片段，每段前面有【路径】。` +
      `请写一段${word}的小结：先用一两句话说${word}主要在做什么，再分点列出各篇的进展。` +
      '每一点结尾用 `[[路径]]` 标出是哪一篇（去掉 .md 后缀）。' +
      '**只根据给出的片段写**，不要发挥、不要评价、不要鼓励的话。直接输出正文，不要前言。',
  };
}

/**
 * **查询扩写**：把一句问话变成一串检索词。
 *
 * 本机检索是词法的——问「降价」找不到写着「打折」的那篇。真正的解法是语义向量，
 * 但那要嵌入模型、要存索引、要随笔记增量更新，是另一个量级。
 * 这里用一次极小的调用换到大部分收益：让模型给几个同义/相关词，再拿去本地检索。
 *
 * 只在**本机检索命中不足时**才调用——多数问题第一次就找到了，不该为此多花一次钱。
 */
export function expandQueryMessages(question: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        '把用户的问题改写成用于全文检索的关键词。输出 5~10 个词，用空格分隔，只输出这一行。' +
        '包含同义词与相关说法（例如「降价」也给出「打折」「定价」「折扣」）。不要解释，不要标点。',
    },
    { role: 'user', content: question },
  ];
}

/** 把检索到的片段拼成一段给模型看的资料，每段带出处 */
export function buildVaultContext(passages: readonly { path: string; text: string }[]): string {
  return passages.map((p) => `【出处：${p.path}】\n${p.text}`).join('\n\n---\n\n');
}

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

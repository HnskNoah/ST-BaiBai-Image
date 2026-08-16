import { getContext } from '@/st/context';
import type { ApiChannel } from '@/state/settings';

/**
 * 通过 SillyTavern 的服务端代理调用任意 OpenAI 兼容端点。
 * (与柏宝书 src/api/client.ts 同源,行为保持一致。)
 *
 * 关键:以 chat_completion_source='openai' + reverse_proxy(base url)+ proxy_password(key)
 * 走 /api/backends/chat-completions/generate。请求由 ST 服务端转发,
 * 因此没有浏览器 CORS 问题,也无需把密钥存进 ST 的 secrets。
 */

const GENERATE_URL = '/api/backends/chat-completions/generate';
const DEFAULT_TIMEOUT_SEC = 180;

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * 规范化 OpenAI 兼容 base url:
 * - 用户填完整 /chat/completions 时只去掉端点后缀;
 * - 纯域名自动补 /v1;
 * - 已带路径的地址原样保留,避免破坏 /v2/coding 等自定义路由。
 */
function normalizeUrl(url: string): string {
  const u = url.trim().replace(/\/+$/, '');
  if (!u) return u;
  if (/\/chat\/completions$/i.test(u)) return u.replace(/\/chat\/completions$/i, '');
  if (/^https?:\/\/[^/?#]+$/i.test(u)) return `${u}/v1`;
  return u;
}

/** 测试渠道时备用的 /v1 形式。只在首个地址明确返回 404/405 时才会尝试。 */
function alternateUrl(url: string): string {
  return /\/v1$/i.test(url) ? url.replace(/\/v1$/i, '') : `${url}/v1`;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

function validTimeoutSec(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_TIMEOUT_SEC;
}

/**
 * 给完整请求生命周期套超时:不仅覆盖 fetch 建连,也覆盖非流式 JSON 读取和流式 SSE 读取。
 * 外部 signal 仍可提前取消;只有本定时器触发时才转换成明确的超时报错。
 */
async function withTimeout<T>(
  timeoutSec: number,
  externalSignal: AbortSignal | undefined,
  label: string,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ctrl = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => ctrl.abort();
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, Math.max(1000, timeoutSec * 1000));

  try {
    return await task(ctrl.signal);
  } catch (e) {
    if (timedOut) throw new ApiError(`${label}超时(>${timeoutSec}秒)`);
    throw e;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * 发起一次补全请求,返回文本内容。
 */
export async function requestCompletion(
  channel: ApiChannel,
  messages: ChatMsg[],
  opts: RequestOptions = {},
): Promise<string> {
  return requestCompletionAtUrl(channel, messages, normalizeUrl(channel.url), opts);
}

async function requestCompletionAtUrl(
  channel: ApiChannel,
  messages: ChatMsg[],
  reverseProxy: string,
  opts: RequestOptions = {},
): Promise<string> {
  const ctx = getContext();
  if (!ctx) throw new ApiError('SillyTavern 上下文不可用');
  if (!channel.url || !channel.model) throw new ApiError('副 API 渠道未配置完整(缺 url 或 model)');

  const stream = channel.stream ?? false;
  // 预填充开关(默认开):关闭时丢掉末尾那条 assistant 预填充消息。
  // 对不支持预填充(不续写)的端点形同浪费、个别端点还要求「最后一条须为 user」。
  const outMessages =
    channel.prefill === false && messages[messages.length - 1]?.role === 'assistant'
      ? messages.slice(0, -1)
      : messages;
  const body: Record<string, unknown> = {
    chat_completion_source: 'openai',
    reverse_proxy: reverseProxy,
    proxy_password: channel.key || '',
    model: channel.model,
    messages: outMessages,
    temperature: channel.temperature ?? 1.0,
    max_tokens: channel.maxTokens ?? 65535,
    stream,
    // 静默:不影响主对话状态
    presence_penalty: 0,
    frequency_penalty: 0,
  };

  // 排除参数:把用户指定的字段从 body 删掉,规避不接受这些参数的兼容端点报错。
  for (const p of channel.excludeParams ?? []) {
    const key = p.trim();
    if (key) delete body[key];
  }

  const timeoutSec = validTimeoutSec(channel.timeoutSec);
  return withTimeout(timeoutSec, opts.signal, '副 API 请求', async signal => {
    const resp = await fetch(GENERATE_URL, {
      method: 'POST',
      headers: ctx.getRequestHeaders(),
      body: JSON.stringify(body),
      signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new ApiError(`副 API 请求失败 (${resp.status}): ${text.slice(0, 300)}`, resp.status);
    }

    // 流式:按 SSE 增量拼接;非流式:直接解析 JSON。
    if (stream) {
      const content = await readSseContent(resp);
      if (!content) throw new ApiError('副 API 返回空内容');
      return content;
    }

    const data = await resp.json();
    if (data?.error) {
      throw new ApiError(data.error.message || '副 API 返回错误');
    }

    const content = extractContent(data);
    if (!content) throw new ApiError('副 API 返回空内容');
    return content;
  });
}

/**
 * 读取 SSE 流(text/event-stream),拼接 delta.content。
 * ST 的 generate 端点在 stream=true 时透传上游 SSE:每行 `data: {json}`,以 `data: [DONE]` 结束。
 * 推理模型的思维链增量(delta.reasoning 等)单独缓冲:只有 content 全空时才回退用它,
 * 避免在 content 正常时把思维链混进正文。
 */
export async function readSseContent(resp: Response): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) {
    // 无法流式读取(理论上不会):退回当作整体 JSON 处理
    const data = await resp.json().catch(() => null);
    return data ? extractContent(data) : '';
  }
  const decoder = new TextDecoder();
  let buf = '';
  let out = '';
  let reasoningOut = '';
  for (; ;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // 按行解析,保留最后一段不完整的行到下次
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t || !t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        if (json?.error) throw new ApiError(json.error.message || '副 API 返回错误');
        const choice = json?.choices?.[0];
        const src = choice?.delta ?? choice?.message;
        const piece = textOf(src?.content) || textOf(choice?.text);
        if (piece) out += piece;
        const reasoningPiece =
          textOf(src?.reasoning) || textOf(src?.reasoning_content) || textOf(src?.thinking);
        if (reasoningPiece) reasoningOut += reasoningPiece;
      } catch (e) {
        if (e instanceof ApiError) throw e;
        // 单行解析失败忽略(可能是注释行/心跳)
      }
    }
  }
  return out.trim() || reasoningOut.trim();
}

/** 把可能是 string / content-parts 数组 / 其他类型的值转成文本;非字符串成分一律丢弃。 */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    let out = '';
    for (const part of value) {
      if (typeof part === 'string') out += part;
      else if (part && typeof part === 'object') {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === 'string') out += text;
      }
    }
    return out;
  }
  return '';
}

/**
 * 从响应体提取答案文本。
 * 标准链:message.content / choices[0].text / data.content;
 * 推理模型(如 deepseek-v4-flash)可能把整段答案(思维链+最终 JSON)全放进
 * reasoning / reasoning_content / thinking 而 content 为空——标准链全空时回退取之,
 * 混入的思维链由 parseImagePlan 的 JSON 块扫描自然剔除。
 */
export function extractContent(data: any): string {
  const msg = data?.choices?.[0]?.message;
  const content =
    textOf(msg?.content) || textOf(data?.choices?.[0]?.text) || textOf(data?.content);
  if (content.trim()) return content.trim();
  return (
    textOf(msg?.reasoning) || textOf(msg?.reasoning_content) || textOf(msg?.thinking)
  ).trim();
}

/* ============ 跟随主 API(主界面当前在用的 API 设置) ============ */

/** 跟随主 API 时的响应上限:够装下思维链 + 输出,避免被主 API 默认 max tokens 截断。 */
const MAIN_API_RESPONSE_LENGTH = 65535;

/**
 * 是否具备「跟随主 API」的条件:ST 暴露了 generateRaw(稳定 API)即可。
 * 不再依赖连接管理/连接档——直接借用主界面当前正在用的 API。
 */
export function mainApiAvailable(): boolean {
  return typeof getContext()?.generateRaw === 'function';
}

/**
 * 用「当前主 API」(主界面正在用的聊天补全/文本补全设置)发一次补全。
 * 走 ST 的 generateRaw:只发我们给的这几条消息,不带聊天历史/角色卡;无需连接档。
 * quiet 类型内部强制非流式,返回清洗后的整段文本;失败抛 ApiError。
 */
export async function requestViaMainApi(messages: ChatMsg[], _opts: RequestOptions = {}): Promise<string> {
  const ctx = getContext();
  if (typeof ctx?.generateRaw !== 'function') {
    throw new ApiError('当前 ST 版本不支持 generateRaw,无法跟随主 API');
  }
  const content = (await ctx.generateRaw({ prompt: messages, responseLength: MAIN_API_RESPONSE_LENGTH }))?.trim();
  if (!content) throw new ApiError('主 API 返回空内容');
  return content;
}

/** 连通性测试:发一条极短请求 */
export async function testChannel(channel: ApiChannel): Promise<{ ok: boolean; message: string }> {
  const primaryUrl = normalizeUrl(channel.url);
  try {
    const reply = await requestCompletionAtUrl(
      channel,
      [{ role: 'user', content: '回复"ok"两个字符即可。' }],
      primaryUrl,
    );
    const changed = channel.url.trim().replace(/\/+$/, '') !== primaryUrl;
    if (changed) channel.url = primaryUrl;
    return {
      ok: true,
      message: `连通正常${changed ? `,已采用:${primaryUrl}` : ''},返回:${reply.slice(0, 40)}`,
    };
  } catch (e) {
    if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 405)) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }

    const fallbackUrl = alternateUrl(primaryUrl);
    if (!fallbackUrl || fallbackUrl === primaryUrl) {
      return { ok: false, message: e.message };
    }
    try {
      const reply = await requestCompletionAtUrl(
        channel,
        [{ role: 'user', content: '回复"ok"两个字符即可。' }],
        fallbackUrl,
      );
      channel.url = fallbackUrl;
      return {
        ok: true,
        message: `连通正常,已自动改用:${fallbackUrl},返回:${reply.slice(0, 40)}`,
      };
    } catch {
      // 备用地址也失败时保留首个错误,避免把模型名等真实问题掩盖成路径错误。
      return { ok: false, message: e.message };
    }
  }
}

const STATUS_URL = '/api/backends/chat-completions/status';

/**
 * 拉取渠道可用的模型列表(走 ST 的 /status 代理,标准 /v1/models)。
 * 只需 url + key,不需要先填 model。
 */
export async function fetchModels(
  channel: Pick<ApiChannel, 'url' | 'key'> & Partial<Pick<ApiChannel, 'timeoutSec'>>,
): Promise<string[]> {
  const ctx = getContext();
  if (!ctx) throw new ApiError('SillyTavern 上下文不可用');
  if (!channel.url) throw new ApiError('请先填写 API 地址');

  const body = {
    chat_completion_source: 'openai',
    reverse_proxy: normalizeUrl(channel.url),
    proxy_password: channel.key || '',
  };

  const timeoutSec = validTimeoutSec(channel.timeoutSec);
  return withTimeout(timeoutSec, undefined, '拉取模型', async signal => {
    const resp = await fetch(STATUS_URL, {
      method: 'POST',
      headers: ctx.getRequestHeaders(),
      body: JSON.stringify(body),
      signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new ApiError(`拉取模型失败 (${resp.status}): ${text.slice(0, 200)}`);
    }

    const data = await resp.json();
    if (data?.error && !Array.isArray(data?.data)) {
      throw new ApiError(data?.message || '拉取模型失败');
    }

    const list: unknown = data?.data ?? data?.models ?? [];
    if (!Array.isArray(list)) return [];
    return list
      .map((m: any) => (typeof m === 'string' ? m : m?.id))
      .filter((x: unknown): x is string => typeof x === 'string' && x.length > 0)
      .sort();
  });
}

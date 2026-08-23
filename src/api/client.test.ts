import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractContent, readSseContent, requestCompletion } from './client';

/** 历史层全部 mock 掉:这里要断的正是「什么时候记成功/失败」 */
const h = vi.hoisted(() => ({
  beginLlm: vi.fn(() => 1),
  finishLlm: vi.fn(),
  failLlm: vi.fn(),
  patchLlmTokens: vi.fn(),
}));

vi.mock('@/state/history', () => ({
  FOLLOW_MAIN_API: '跟随主 API',
  beginLlm: h.beginLlm,
  finishLlm: h.finishLlm,
  failLlm: h.failLlm,
  patchLlmTokens: h.patchLlmTokens,
  // 与真实实现同语义:吞异常返回 null
  safeHistory: (fn: () => unknown) => {
    try {
      return fn();
    } catch {
      return null;
    }
  },
}));

vi.mock('@/st/context', () => ({
  getContext: () => ({ getRequestHeaders: () => ({}) }),
}));

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const channel = {
  id: 'ch1',
  name: '测试渠道',
  url: 'https://api.example.com',
  key: 'k',
  model: 'm',
  temperature: 1,
  maxTokens: 1024,
  timeoutSec: 60,
  stream: false,
  prefill: true,
  excludeParams: [],
};
const messages = [{ role: 'user' as const, content: 'hi' }];
/** 带 usage 的响应:避免触发 token 估算分支(那需要主界面分词器) */
const okPayload = {
  choices: [{ message: { role: 'assistant', content: '  答案文本  ' } }],
  usage: { prompt_tokens: 5, completion_tokens: 7 },
};

/** 造一个最小 Response,可读出给定 SSE 文本 */
function sseResponse(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('extractContent:标准响应', () => {
  it('message.content 正常提取', () => {
    const data = { choices: [{ message: { role: 'assistant', content: 'hello' } }] };
    expect(extractContent(data)).toBe('hello');
  });

  it('兼容 choices[0].text 与顶层 content', () => {
    expect(extractContent({ choices: [{ text: 'legacy' }] })).toBe('legacy');
    expect(extractContent({ content: 'top-level' })).toBe('top-level');
  });

  it('content 为 content-parts 数组时拼接各段 text', () => {
    const data = { choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] };
    expect(extractContent(data)).toBe('ab');
  });

  it('content 为 null 时返回空串而非抛错', () => {
    const data = { choices: [{ message: { role: 'assistant', content: null, refusal: null } }] };
    expect(extractContent(data)).toBe('');
  });
});

describe('extractContent:推理模型把答案塞进 reasoning', () => {
  it('content 为空时回退 reasoning', () => {
    const data = {
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          reasoning: '思考过程…\n\n{"images":[],"changes":[]}',
        },
      }],
    };
    expect(extractContent(data)).toContain('"images"');
  });

  it('content 为空时回退 reasoning_content(DeepSeek 标准字段)', () => {
    const data = {
      choices: [{
        message: { role: 'assistant', content: null, reasoning_content: '答案在里' },
      }],
    };
    expect(extractContent(data)).toBe('答案在里');
  });

  it('content 为空时回退 thinking', () => {
    const data = { choices: [{ message: { content: null, thinking: 'via thinking' } }] };
    expect(extractContent(data)).toBe('via thinking');
  });

  it('content 非空时绝不混入 reasoning', () => {
    const data = {
      choices: [{
        message: { role: 'assistant', content: 'final answer', reasoning: 'chain of thought' },
      }],
    };
    expect(extractContent(data)).toBe('final answer');
  });
});

describe('readSseContent:流式', () => {
  it('拼接 delta.content', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      'data: [DONE]',
      '',
    ].join('\n');
    await expect(readSseContent(sseResponse(sse))).resolves.toBe('Hello');
  });

  it('content 全空时回退拼接 reasoning 增量', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"reasoning":"思考"}}]}',
      'data: {"choices":[{"delta":{"reasoning_content":"…{\\"images\\":[]}"}}]}',
      'data: {"choices":[{"delta":{}}]}',
      'data: [DONE]',
      '',
    ].join('\n');
    await expect(readSseContent(sseResponse(sse))).resolves.toContain('"images"');
  });

  it('content 出现后忽略 reasoning,不拼接', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"reasoning":"先想"}}]}',
      'data: {"choices":[{"delta":{"content":"答案"}}]}',
      'data: {"choices":[{"delta":{"content":"!"}}]}',
      'data: [DONE]',
      '',
    ].join('\n');
    await expect(readSseContent(sseResponse(sse))).resolves.toBe('答案!');
  });
});

describe('validate:历史「成功」= 调用方验收通过', () => {
  beforeEach(() => {
    h.beginLlm.mockClear();
    h.finishLlm.mockClear();
    h.failLlm.mockClear();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(okPayload)));
  });

  it('验收通过 → 返回文本,历史记成功', async () => {
    const seen: string[] = [];
    const text = await requestCompletion(channel, messages, {
      validate: raw => seen.push(raw),
    });
    expect(text).toBe('答案文本');
    expect(seen).toEqual(['答案文本']); // validate 拿到的是提取后的正文
    expect(h.finishLlm).toHaveBeenCalledTimes(1);
    expect(h.failLlm).not.toHaveBeenCalled();
  });

  it('不传 validate → 维持旧行为:拿到文本即记成功', async () => {
    await expect(requestCompletion(channel, messages)).resolves.toBe('答案文本');
    expect(h.finishLlm).toHaveBeenCalledTimes(1);
  });

  it('验收抛错 → 请求按失败抛出,历史记失败而非成功', async () => {
    // 这是「HTTP 成功但协议解析不过」的场景:必须 failLlm,否则重试会在历史里
    // 留下两条绿色成功记录,看历史的人会误以为成功也重复调用。
    await expect(
      requestCompletion(channel, messages, {
        validate: () => {
          throw new Error('协议不合法');
        },
      }),
    ).rejects.toThrow('协议不合法');
    expect(h.finishLlm).not.toHaveBeenCalled();
    expect(h.failLlm).toHaveBeenCalledWith(1, '协议不合法', false);
  });

  it('HTTP 失败时 validate 根本不该被调用', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    );
    const validate = vi.fn();
    await expect(requestCompletion(channel, messages, { validate })).rejects.toThrow('500');
    expect(validate).not.toHaveBeenCalled();
    expect(h.failLlm).toHaveBeenCalledTimes(1);
  });
});

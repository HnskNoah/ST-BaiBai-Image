import { describe, expect, it } from 'vitest';
import { extractContent, readSseContent } from './client';

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

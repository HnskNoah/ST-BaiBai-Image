import { describe, expect, it } from 'vitest';

// 空回 / API 错误文本三分类(用例与 ST-Quicker-Api 的 tests/response-triage.test.ts 同源,
// 两边用例保持一致:规则在任一侧演进时,另一侧同步)。
import { INLINE_TRIAGE_MAX_LEN, triageAssistantText } from '@/autoTag/triage';

describe('triageAssistantText — api_error', () => {
  it.each([
    '[API错误] model not found',
    '[API 错误] model not found',
    '[API Error] model not found',
    '【API错误】model not found',
    '【 API 错误 】 model not found',
    '\uFEFF  [ API\u00A0错误 ]  model not found',
    // 标记内携带补充信息(闭括号不紧跟 错误/error)
    '[API Error: rate limit exceeded] please retry later',
    '[API错误：当前分组对该模型无可用渠道]',
    // markdown 噪声前缀
    '**[API错误]** 上游故障',
    '> [API错误] 上游故障',
    // 流式截断的未闭合标记
    '[API错误：上游连接在响应中途断开',
  ])('recognizes marker: %s', text => {
    const triage = triageAssistantText(text);
    expect(triage.kind).toBe('api_error');
    expect(triage.detail).toBe(text.trim());
  });

  it('recognizes a closed marker anywhere in a short body (streaming partial then error)', () => {
    const body = '她推开门。[API错误] 上游连接中断';
    expect(triageAssistantText(body).kind).toBe('api_error');
  });

  it('caps the detail excerpt at 500 characters', () => {
    const long = `[API错误]${'x'.repeat(900)}`;
    expect(triageAssistantText(long).detail?.length).toBe(500);
  });
});

describe('triageAssistantText — empty', () => {
  it.each(['', '   ', '\n\t ', null, undefined])('treats %j as empty', text => {
    expect(triageAssistantText(text)).toEqual({ kind: 'empty', detail: null });
  });
});

describe('triageAssistantText — ok', () => {
  it('does not classify a long narrative that merely mentions the marker', () => {
    const narrative = `${'她推开门，走进房间。'.repeat(40)}[API错误] 只是故事里的道具`;
    expect(narrative.length).toBeGreaterThan(INLINE_TRIAGE_MAX_LEN);
    expect(triageAssistantText(narrative).kind).toBe('ok');
  });

  it('does not classify ordinary responses without any marker', () => {
    expect(triageAssistantText('ordinary model response').kind).toBe('ok');
    expect(triageAssistantText('apology is not an api error').kind).toBe('ok');
  });
});

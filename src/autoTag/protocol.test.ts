import { describe, expect, it } from 'vitest';

import {
  injectImageTags,
  numberSourceText,
  parseImagePlan,
  sourceLineCount,
} from '@/autoTag/protocol';

describe('auto tag line protocol', () => {
  it('numbers every physical source line including blank lines', () => {
    const source = '第一行\n\n第三行';
    expect(sourceLineCount(source)).toBe(3);
    expect(numberSourceText(source)).toBe('[L0001] 第一行\n[L0002] \n[L0003] 第三行');
  });

  it('parses a fenced JSON response and applies the local maximum', () => {
    const raw = `说明文字\n\`\`\`json
{"images":[{"line":1,"tag":"first scene"},{"line":3,"tag":"second scene"}]}
\`\`\``;
    expect(parseImagePlan(raw, 3, 1)).toEqual({
      images: [{ line: 1, tag: 'first scene', nl: '', size: 'portrait' }],
      changes: [],
    });
  });

  it('accepts the legacy prompt key as an alias of tag', () => {
    expect(parseImagePlan('{"images":[{"line":1,"prompt":"scene"}]}', 1, 1)).toEqual({
      images: [{ line: 1, tag: 'scene', nl: '', size: 'portrait' }],
      changes: [],
    });
  });

  it('keeps the optional nl part and collapses its newlines', () => {
    const raw = '{"images":[{"line":1,"tag":"1girl","nl":"A girl.\\nShe smiles."}]}';
    expect(parseImagePlan(raw, 1, 1)).toEqual({
      images: [{ line: 1, tag: '1girl', nl: 'A girl. She smiles.', size: 'portrait' }],
      changes: [],
    });
  });

  it('takes the landscape orientation from the size key', () => {
    const raw = '{"images":[{"line":1,"tag":"2girls","size":"landscape"}]}';
    expect(parseImagePlan(raw, 1, 1)).toEqual({
      images: [{ line: 1, tag: '2girls', nl: '', size: 'landscape' }],
      changes: [],
    });
  });

  it('falls back to portrait for a missing or garbled size instead of throwing', () => {
    // 为方向抛错会白白吃掉 runner 的重试次数,所以一律容忍降级
    expect(parseImagePlan('{"images":[{"line":1,"tag":"a"}]}', 1, 1).images[0].size).toBe('portrait');
    expect(parseImagePlan('{"images":[{"line":1,"tag":"a","size":"随便"}]}', 1, 1).images[0].size).toBe(
      'portrait',
    );
    expect(parseImagePlan('{"images":[{"line":1,"tag":"a","size":123}]}', 1, 1).images[0].size).toBe(
      'portrait',
    );
  });

  it('still reads the orientation out of loose Chinese wording', () => {
    expect(parseImagePlan('{"images":[{"line":1,"tag":"a","size":"横屏"}]}', 1, 1).images[0].size).toBe(
      'landscape',
    );
    expect(parseImagePlan('{"images":[{"line":1,"tag":"a","size":"竖版"}]}', 1, 1).images[0].size).toBe(
      'portrait',
    );
  });

  it('accepts orientation/aspect as aliases of size', () => {
    expect(
      parseImagePlan('{"images":[{"line":1,"tag":"a","orientation":"landscape"}]}', 1, 1).images[0].size,
    ).toBe('landscape');
    expect(parseImagePlan('{"images":[{"line":1,"tag":"a","aspect":"16:9"}]}', 1, 1).images[0].size).toBe(
      'landscape',
    );
  });

  it('rejects line numbers outside the target source', () => {
    expect(() =>
      parseImagePlan('{"images":[{"line":4,"tag":"scene"}]}', 3, 2),
    ).toThrow('超出目标正文');
  });

  it('rejects nested bbi tags in prompts', () => {
    expect(() =>
      parseImagePlan(
        '{"images":[{"line":1,"tag":"<bbi_image>bad</bbi_image>"}]}',
        1,
        1,
      ),
    ).toThrow('不得包含');
  });

  it('rejects sub-tag literals in the nl part', () => {
    expect(() =>
      parseImagePlan('{"images":[{"line":1,"tag":"ok","nl":"bad</nl>"}]}', 1, 1),
    ).toThrow('不得包含');
  });

  it('rejects a fake size sub-tag smuggled into the tag text', () => {
    expect(() =>
      parseImagePlan('{"images":[{"line":1,"tag":"1girl<size>landscape</size>"}]}', 1, 1),
    ).toThrow('不得包含');
  });

  it('inserts multiple tags after the same line in array order', () => {
    expect(
      injectImageTags('第一行\n第二行', [
        { line: 1, tag: 'prompt a', nl: '', size: 'portrait' },
        { line: 1, tag: 'prompt b', nl: '', size: 'landscape' },
      ]),
    ).toBe(
      '第一行\n<bbi_image>prompt a<size>portrait</size></bbi_image>\n<bbi_image>prompt b<size>landscape</size></bbi_image>\n第二行',
    );
  });

  it('wraps the nl part in a <nl> sub-tag, keeping the tag part bare', () => {
    expect(
      injectImageTags('第一行', [
        { line: 1, tag: '1girl, moonlight', nl: 'A girl in moonlight.', size: 'portrait' },
      ]),
    ).toBe(
      '第一行\n<bbi_image>1girl, moonlight<nl>A girl in moonlight.</nl><size>portrait</size></bbi_image>',
    );
  });

  it('preserves CRLF and appends correctly after the final line', () => {
    expect(
      injectImageTags('第一行\r\n\r\n第三行', [
        { line: 1, tag: 'prompt a', nl: '', size: 'portrait' },
        { line: 3, tag: 'prompt c', nl: '', size: 'portrait' },
      ]),
    ).toBe(
      '第一行\r\n<bbi_image>prompt a<size>portrait</size></bbi_image>\r\n\r\n第三行\r\n<bbi_image>prompt c<size>portrait</size></bbi_image>',
    );
  });
});

describe('changes parsing', () => {
  it('parses valid character changes alongside images', () => {
    const raw =
      '{"images":[{"line":1,"tag":"@小雪"}],"changes":[{"name":"小雪","field":"hair","value":"short black hair","reason":"剪了短发"}]}';
    expect(parseImagePlan(raw, 1, 1).changes).toEqual([
      { name: '小雪', field: 'hair', value: 'short black hair', nl: undefined, reason: '剪了短发' },
    ]);
  });

  it('accepts new-entry changes with value or structured fields', () => {
    const raw =
      '{"images":[],"changes":[{"name":"新角色","field":"new","value":"1girl, red eyes","reason":"建档"},{"name":"结构角色","field":"new","fields":{"sex":"1girl","hair":"blonde"},"reason":"建档"}]}';
    expect(parseImagePlan(raw, 1, 1).changes).toEqual([
      { name: '新角色', field: 'new', value: '1girl, red eyes', nl: undefined, reason: '建档' },
      {
        name: '结构角色',
        field: 'new',
        value: '{"sex":"1girl","hair":"blonde"}',
        nl: undefined,
        reason: '建档',
      },
    ]);
  });

  it('drops invalid change records but keeps the rest', () => {
    const raw =
      '{"images":[],"changes":[{"name":"","field":"hair","value":"x"},{"name":"A","field":"bogus","value":"x"},{"name":"B","field":"hair","value":"ok","reason":"r"},"junk",{"name":"C","field":"nl","nl":"a girl with long hair"}]}';
    expect(parseImagePlan(raw, 1, 1).changes).toEqual([
      { name: 'B', field: 'hair', value: 'ok', nl: undefined, reason: 'r' },
      { name: 'C', field: 'nl', value: '', nl: 'a girl with long hair', reason: '' },
    ]);
  });

  it('missing changes key yields an empty array', () => {
    expect(parseImagePlan('{"images":[{"line":1,"tag":"a"}]}', 1, 1).changes).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';

import {
  injectImageTags,
  parseImagePlan,
} from '@/autoTag/protocol';

const segments = [
  { id: 'P1', sourceLine: 0, text: '第一幕结束' },
  { id: 'P2', sourceLine: 2, text: '第二幕结束' },
];

describe('auto tag position protocol', () => {
  it('parses a fenced JSON response and applies the local maximum', () => {
    const raw = `说明文字\n\`\`\`json
{"images":[{"position":"P1","tag":"first scene"},{"position":"P2","tag":"second scene"}]}
\`\`\``;
    expect(parseImagePlan(raw, segments, 1)).toEqual({
      images: [
        { position: 'P1', sourceLine: 0, tag: 'first scene', nl: '', negative: '', size: 'portrait' },
      ],
      changes: [],
    });
  });

  it('accepts the legacy prompt key as an alias of tag', () => {
    expect(parseImagePlan('{"images":[{"position":"P1","prompt":"scene"}]}', segments, 1)).toEqual({
      images: [{ position: 'P1', sourceLine: 0, tag: 'scene', nl: '', negative: '', size: 'portrait' }],
      changes: [],
    });
  });

  it('keeps the optional nl part and collapses its newlines', () => {
    const raw = '{"images":[{"position":"P1","tag":"1girl","nl":"A girl.\\nShe smiles."}]}';
    expect(parseImagePlan(raw, segments, 1)).toEqual({
      images: [
        {
          position: 'P1',
          sourceLine: 0,
          tag: '1girl',
          nl: 'A girl. She smiles.',
          negative: '',
          size: 'portrait',
        },
      ],
      changes: [],
    });
  });

  it('takes the landscape orientation from the size key', () => {
    const raw = '{"images":[{"position":"P1","tag":"2girls","size":"landscape"}]}';
    expect(parseImagePlan(raw, segments, 1)).toEqual({
      images: [
        { position: 'P1', sourceLine: 0, tag: '2girls', nl: '', negative: '', size: 'landscape' },
      ],
      changes: [],
    });
  });

  it('falls back to portrait for a missing or garbled size instead of throwing', () => {
    // 为方向抛错会白白吃掉 runner 的重试次数,所以一律容忍降级
    expect(parseImagePlan('{"images":[{"position":"P1","tag":"a"}]}', segments, 1).images[0].size).toBe('portrait');
    expect(parseImagePlan('{"images":[{"position":"P1","tag":"a","size":"随便"}]}', segments, 1).images[0].size).toBe('portrait');
    expect(parseImagePlan('{"images":[{"position":"P1","tag":"a","size":123}]}', segments, 1).images[0].size).toBe('portrait');
  });

  it('still reads the orientation out of loose Chinese wording', () => {
    expect(parseImagePlan('{"images":[{"position":"P1","tag":"a","size":"横屏"}]}', segments, 1).images[0].size).toBe('landscape');
    expect(parseImagePlan('{"images":[{"position":"P1","tag":"a","size":"竖版"}]}', segments, 1).images[0].size).toBe('portrait');
  });

  it('accepts orientation/aspect as aliases of size', () => {
    expect(
      parseImagePlan('{"images":[{"position":"P1","tag":"a","orientation":"landscape"}]}', segments, 1).images[0].size,
    ).toBe('landscape');
    expect(parseImagePlan('{"images":[{"position":"P1","tag":"a","aspect":"16:9"}]}', segments, 1).images[0].size).toBe(
      'landscape',
    );
  });

  it('normalizes lowercase position IDs and accepts id as an alias', () => {
    expect(parseImagePlan('{"images":[{"id":"p2","tag":"scene"}]}', segments, 1).images[0]).toMatchObject({
      position: 'P2',
      sourceLine: 2,
    });
  });

  it('rejects positions missing from the target source', () => {
    expect(() =>
      parseImagePlan('{"images":[{"position":"P9","tag":"scene"}]}', segments, 2),
    ).toThrow('不在目标正文');
  });

  it('rejects malformed position IDs', () => {
    expect(() =>
      parseImagePlan('{"images":[{"position":"第二段","tag":"scene"}]}', segments, 2),
    ).toThrow('P编号');
  });

  it('rejects nested bbi tags in prompts', () => {
    expect(() =>
      parseImagePlan(
        '{"images":[{"position":"P1","tag":"<bbi_image>bad</bbi_image>"}]}',
        segments,
        1,
      ),
    ).toThrow('不得包含');
  });

  it('rejects sub-tag literals in the nl part', () => {
    expect(() =>
      parseImagePlan('{"images":[{"position":"P1","tag":"ok","nl":"bad</nl>"}]}', segments, 1),
    ).toThrow('不得包含');
  });

  it('rejects a fake size sub-tag smuggled into the tag text', () => {
    expect(() =>
      parseImagePlan('{"images":[{"position":"P1","tag":"1girl<size>landscape</size>"}]}', segments, 1),
    ).toThrow('不得包含');
  });

  it('keeps the optional dynamic negative part and accepts negative_prompt as an alias', () => {
    const raw =
      '{"images":[{"position":"P1","tag":"1girl","negative_prompt":"extra people, duplicate"}]}';
    expect(parseImagePlan(raw, segments, 1).images[0].negative).toBe('extra people, duplicate');
  });

  it('rejects sub-tag literals in the negative part', () => {
    expect(() =>
      parseImagePlan(
        '{"images":[{"position":"P1","tag":"ok","negative":"bad</negative>"}]}',
        segments,
        1,
      ),
    ).toThrow('不得包含');
  });

  it('inserts multiple tags after the same line in array order', () => {
    expect(
      injectImageTags('第一行\n第二行', [
        { position: 'P1', sourceLine: 0, tag: 'prompt a', nl: '', negative: '', size: 'portrait' },
        { position: 'P1', sourceLine: 0, tag: 'prompt b', nl: '', negative: '', size: 'landscape' },
      ]),
    ).toBe(
      '第一行\n<bbi_image>prompt a<size>portrait</size></bbi_image>\n<bbi_image>prompt b<size>landscape</size></bbi_image>\n第二行',
    );
  });

  it('wraps the nl part in a <nl> sub-tag, keeping the tag part bare', () => {
    expect(
      injectImageTags('第一行', [
        {
          position: 'P1',
          sourceLine: 0,
          tag: '1girl, moonlight',
          nl: 'A girl in moonlight.',
          negative: '',
          size: 'portrait',
        },
      ]),
    ).toBe(
      '第一行\n<bbi_image>1girl, moonlight<nl>A girl in moonlight.</nl><size>portrait</size></bbi_image>',
    );
  });

  it('wraps the dynamic negative part in a <negative> sub-tag', () => {
    expect(
      injectImageTags('第一行', [
        {
          position: 'P1',
          sourceLine: 0,
          tag: '1girl',
          nl: '',
          negative: 'extra people, duplicate character',
          size: 'portrait',
        },
      ]),
    ).toBe(
      '第一行\n<bbi_image>1girl<negative>extra people, duplicate character</negative><size>portrait</size></bbi_image>',
    );
  });

  it('preserves CRLF and appends correctly after the final line', () => {
    expect(
      injectImageTags('第一行\r\n\r\n第三行', [
        { position: 'P1', sourceLine: 0, tag: 'prompt a', nl: '', negative: '', size: 'portrait' },
        { position: 'P2', sourceLine: 2, tag: 'prompt c', nl: '', negative: '', size: 'portrait' },
      ]),
    ).toBe(
      '第一行\r\n<bbi_image>prompt a<size>portrait</size></bbi_image>\r\n\r\n第三行\r\n<bbi_image>prompt c<size>portrait</size></bbi_image>',
    );
  });
});

describe('changes parsing', () => {
  it('parses valid character changes alongside images', () => {
    const raw =
      '{"images":[{"position":"P1","tag":"@小雪"}],"changes":[{"name":"小雪","field":"hair","value":"short black hair","reason":"剪了短发"}]}';
    expect(parseImagePlan(raw, segments, 1).changes).toEqual([
      { name: '小雪', field: 'hair', value: 'short black hair', nl: undefined, reason: '剪了短发' },
    ]);
  });

  it('accepts new-entry changes with value or structured fields', () => {
    const raw =
      '{"images":[],"changes":[{"name":"新角色","field":"new","value":"1girl, red eyes","reason":"建档"},{"name":"结构角色","field":"new","fields":{"sex":"1girl","hair":"blonde"},"reason":"建档"}]}';
    expect(parseImagePlan(raw, segments, 1).changes).toEqual([
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
    expect(parseImagePlan(raw, segments, 1).changes).toEqual([
      { name: 'B', field: 'hair', value: 'ok', nl: undefined, reason: 'r' },
      { name: 'C', field: 'nl', value: '', nl: 'a girl with long hair', reason: '' },
    ]);
  });

  it('missing changes key yields an empty array', () => {
    expect(parseImagePlan('{"images":[{"position":"P1","tag":"a"}]}', segments, 1).changes).toEqual([]);
  });
});

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
      images: [{ line: 1, tag: 'first scene', nl: '' }],
    });
  });

  it('accepts the legacy prompt key as an alias of tag', () => {
    expect(parseImagePlan('{"images":[{"line":1,"prompt":"scene"}]}', 1, 1)).toEqual({
      images: [{ line: 1, tag: 'scene', nl: '' }],
    });
  });

  it('keeps the optional nl part and collapses its newlines', () => {
    const raw = '{"images":[{"line":1,"tag":"1girl","nl":"A girl.\\nShe smiles."}]}';
    expect(parseImagePlan(raw, 1, 1)).toEqual({
      images: [{ line: 1, tag: '1girl', nl: 'A girl. She smiles.' }],
    });
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

  it('inserts multiple tags after the same line in array order', () => {
    expect(
      injectImageTags('第一行\n第二行', [
        { line: 1, tag: 'prompt a', nl: '' },
        { line: 1, tag: 'prompt b', nl: '' },
      ]),
    ).toBe(
      '第一行\n<bbi_image>prompt a</bbi_image>\n<bbi_image>prompt b</bbi_image>\n第二行',
    );
  });

  it('wraps the nl part in a <nl> sub-tag, keeping the tag part bare', () => {
    expect(
      injectImageTags('第一行', [{ line: 1, tag: '1girl, moonlight', nl: 'A girl in moonlight.' }]),
    ).toBe('第一行\n<bbi_image>1girl, moonlight<nl>A girl in moonlight.</nl></bbi_image>');
  });

  it('preserves CRLF and appends correctly after the final line', () => {
    expect(
      injectImageTags('第一行\r\n\r\n第三行', [
        { line: 1, tag: 'prompt a', nl: '' },
        { line: 3, tag: 'prompt c', nl: '' },
      ]),
    ).toBe(
      '第一行\r\n<bbi_image>prompt a</bbi_image>\r\n\r\n第三行\r\n<bbi_image>prompt c</bbi_image>',
    );
  });
});

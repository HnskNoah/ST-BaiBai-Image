import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ensureImageTagRegexRegistered,
  IMAGE_TAG_HIDE_REGEX_ID,
  IMAGE_TAG_SLOT_REGEX_ID,
  imageTagHideScript,
  imageTagSlotScript,
  parseImageTagContent,
  parseImageTags,
  stripImageTags,
} from '@/st/imageTagRegex';

const SLOT_DIV = '<div data-bbi-slot=""></div>';

function regexFromLiteral(literal: string): RegExp {
  const match = literal.match(/^\/(.*)\/([a-z]*)$/i);
  if (!match) throw new Error('invalid regex literal');
  return new RegExp(match[1], match[2]);
}

afterEach(() => vi.unstubAllGlobals());

describe('display-side slot script (markdownOnly)', () => {
  it('replaces each complete tag block with an empty slot anchor', () => {
    const script = imageTagSlotScript();
    expect(script.markdownOnly).toBe(true);
    expect(script.promptOnly).toBe(false);
    expect(script.placement).toEqual([1, 2]);
    expect(script.id).toBe(IMAGE_TAG_SLOT_REGEX_ID);

    const regex = regexFromLiteral(script.findRegex);
    expect(
      '正文前\n<bbi_image>1girl,\nmoonlight</bbi_image>\n正文后'.replace(regex, script.replaceString),
    ).toBe(`正文前\n${SLOT_DIV}\n正文后`);
  });

  it('handles multiple tags without swallowing text between them', () => {
    const script = imageTagSlotScript();
    const regex = regexFromLiteral(script.findRegex);
    expect(
      '<bbi_image>first</bbi_image>中间正文<bbi_image>second</bbi_image>'.replace(
        regex,
        script.replaceString,
      ),
    ).toBe(`${SLOT_DIV}中间正文${SLOT_DIV}`);
  });
});

describe('prompt-side hide script (promptOnly)', () => {
  it('removes the complete tag block from prompts', () => {
    const script = imageTagHideScript();
    expect(script.markdownOnly).toBe(false);
    expect(script.promptOnly).toBe(true);
    expect(script.placement).toEqual([1, 2]);
    expect(script.id).toBe(IMAGE_TAG_HIDE_REGEX_ID);

    const regex = regexFromLiteral(script.findRegex);
    expect(
      '正文前\n<bbi_image>1girl,\nmoonlight</bbi_image>\n正文后'.replace(regex, script.replaceString),
    ).toBe('正文前\n\n正文后');
  });

  it('shares the same find pattern as the slot script', () => {
    expect(imageTagSlotScript().findRegex).toBe(imageTagHideScript().findRegex);
  });
});

describe('parseImageTags', () => {
  it('returns tags in document order, preserving raw text', () => {
    expect(parseImageTags('a<bbi_image>one</bbi_image>b<bbi_image>two,\nlines</bbi_image>c')).toEqual([
      '<bbi_image>one</bbi_image>',
      '<bbi_image>two,\nlines</bbi_image>',
    ]);
  });

  it('returns an empty array when there are no tags', () => {
    expect(parseImageTags('没有生图标签的正文')).toEqual([]);
  });
});

describe('stripImageTags', () => {
  it('removes plugin-injected tags together with their line break, restoring the original text', () => {
    expect(stripImageTags('第一行\n<bbi_image>1girl</bbi_image>\n第二行')).toBe('第一行\n第二行');
  });

  it('removes multiple tags after the same line and tags with nl/size sub-tags', () => {
    expect(
      stripImageTags(
        '场景\n<bbi_image>1girl<nl>A girl.</nl><size>portrait</size></bbi_image>\n<bbi_image>2boy<size>landscape</size></bbi_image>\n结尾',
      ),
    ).toBe('场景\n结尾');
  });

  it('removes inline hand-written tags without touching surrounding text', () => {
    expect(stripImageTags('前文 <bbi_image>x</bbi_image> 后文')).toBe('前文  后文');
  });

  it('leaves tag-free text untouched and preserves CRLF', () => {
    expect(stripImageTags('没有\r\n标签')).toBe('没有\r\n标签');
  });
});

describe('parseImageTagContent', () => {
  it('treats bare content as the tag part (legacy format)', () => {
    expect(parseImageTagContent('<bbi_image>1girl, moonlight</bbi_image>')).toEqual({
      tag: '1girl, moonlight',
      nl: '',
      size: 'portrait',
    });
  });

  it('splits bare tag text and a <nl> sub-tag (plugin standard form)', () => {
    expect(parseImageTagContent('<bbi_image>1girl<nl>A girl.</nl></bbi_image>')).toEqual({
      tag: '1girl',
      nl: 'A girl.',
      size: 'portrait',
    });
  });

  it('accepts explicit <tag> and <nl> sub-tags in any order', () => {
    expect(
      parseImageTagContent('<bbi_image><nl>A girl.\nShe smiles.</nl><tag>1girl</tag></bbi_image>'),
    ).toEqual({ tag: '1girl', nl: 'A girl. She smiles.', size: 'portrait' });
  });

  it('merges bare text with explicit <tag> content instead of dropping it', () => {
    expect(parseImageTagContent('<bbi_image>bare_tags<tag>explicit_tags</tag></bbi_image>')).toEqual({
      tag: 'bare_tags, explicit_tags',
      nl: '',
      size: 'portrait',
    });
  });

  it('strips <size> out of the tag part instead of leaking it into the prompt', () => {
    // 漏剥的话 landscape 这个词会直接混进正向提示词
    expect(parseImageTagContent('<bbi_image>2girls, wide shot<size>landscape</size></bbi_image>')).toEqual(
      { tag: '2girls, wide shot', nl: '', size: 'landscape' },
    );
  });

  it('handles all three sub-tags together (full plugin form)', () => {
    expect(
      parseImageTagContent('<bbi_image>2girls<nl>Two girls.</nl><size>landscape</size></bbi_image>'),
    ).toEqual({ tag: '2girls', nl: 'Two girls.', size: 'landscape' });
  });

  it('falls back to portrait for legacy tags without <size>', () => {
    // 存量正文里的 tag 没有 size,必须维持改动前的竖屏行为
    expect(parseImageTagContent('<bbi_image>1girl</bbi_image>').size).toBe('portrait');
    expect(parseImageTagContent('<bbi_image>1girl<size>乱写</size></bbi_image>').size).toBe('portrait');
  });
});

describe('managed bbi image-tag regex registration', () => {
  it('registers both scripts once by fixed id and updates old managed rules', () => {
    const saveSettingsDebounced = vi.fn();
    const unrelated = { id: 'user-rule', scriptName: '用户规则' };
    const legacy = {
      id: IMAGE_TAG_HIDE_REGEX_ID,
      scriptName: '柏宝绘 · 隐藏生图标签',
      findRegex: '/old/g',
      markdownOnly: true,
      promptOnly: true,
      placement: [0, 1, 2],
      customField: 'preserved',
    };
    const extensionSettings: Record<string, unknown> = { regex: [unrelated, legacy] };
    vi.stubGlobal('window', {
      SillyTavern: {
        getContext: () => ({ extensionSettings, saveSettingsDebounced }),
      },
    });

    expect(ensureImageTagRegexRegistered()).toBe(true);
    expect(ensureImageTagRegexRegistered()).toBe(true);
    const list = extensionSettings.regex as Array<Record<string, unknown>>;
    expect(list).toHaveLength(3);
    expect(list[0]).toBe(unrelated);

    // 旧单条 hide 规则被原位升级为 promptOnly 版本（不再双开），用户字段保留
    const hide = list.find(s => s.id === IMAGE_TAG_HIDE_REGEX_ID);
    expect(hide).toMatchObject({
      scriptName: '柏宝绘 · 隐藏生图标签',
      markdownOnly: false,
      promptOnly: true,
      placement: [1, 2],
      customField: 'preserved',
    });

    // 新增 slot 规则且只出现一次
    const slots = list.filter(s => s.id === IMAGE_TAG_SLOT_REGEX_ID);
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      scriptName: '柏宝绘 · 生图标签占位',
      markdownOnly: true,
      promptOnly: false,
      placement: [1, 2],
      replaceString: SLOT_DIV,
    });
    expect(saveSettingsDebounced).toHaveBeenCalledTimes(2);
  });
});

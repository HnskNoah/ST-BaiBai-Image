import { describe, expect, it } from 'vitest';

import {
  applyCharRefs,
  buildLibraryText,
  formatEntryForPrompt,
  parseConvertedTags,
} from '@/autoTag/charAnchors';
import type { BookRole } from '@/autoTag/bookMemory';
import { emptyCharFields, type CharTagEntry } from '@/state/charTags';

function entry(name: string, fields: Partial<Record<string, string>>, source: CharTagEntry['source'] = 'ai'): CharTagEntry {
  return {
    name,
    fields: { ...emptyCharFields(), ...fields },
    raw: '',
    nl: '',
    source,
    desc: '',
    history: [],
  };
}

describe('formatEntryForPrompt / buildLibraryText', () => {
  it('renders non-empty fields with labels in fixed order', () => {
    const text = formatEntryForPrompt(entry('小雪', { sex: '1girl', hair: 'long black hair', eyes: 'red eyes' }));
    expect(text).toBe('- 小雪: 性别=1girl, 头发=long black hair, 眼睛=red eyes');
  });

  it('falls back to raw tag when no structured fields', () => {
    const e = entry('旧角色', {});
    e.raw = '1girl, red eyes';
    expect(formatEntryForPrompt(e)).toBe('- 旧角色: tag=1girl, red eyes');
  });

  it('builds the library block with a header', () => {
    const text = buildLibraryText([entry('小雪', { sex: '1girl' })]);
    expect(text).toContain('【角色固定外貌库');
    expect(text).toContain('- 小雪: 性别=1girl');
  });

  it('returns empty string for no entries', () => {
    expect(buildLibraryText([])).toBe('');
  });
});

describe('applyCharRefs', () => {
  const entries = [
    entry('小雪', { sex: '1girl', hair: 'long black hair', eyes: 'red eyes' }),
    entry('张三', { sex: '1boy' }),
  ];

  it('replaces @name placeholders with the joined tag string', () => {
    const { text, unknown } = applyCharRefs('@小雪, white dress, sitting', entries);
    expect(text).toBe('1girl, long black hair, red eyes, white dress, sitting');
    expect(unknown).toEqual([]);
  });

  it('handles multiple placeholders and mixed content', () => {
    const { text } = applyCharRefs('@张三 and @小雪, classroom', entries);
    expect(text).toBe('1boy and 1girl, long black hair, red eyes, classroom');
  });

  it('strips unknown names and tidies separators', () => {
    const { text, unknown } = applyCharRefs('@路人甲, @小雪, smile', entries);
    expect(unknown).toEqual(['路人甲']);
    expect(text).toBe('1girl, long black hair, red eyes, smile');
  });

  it('handles placeholder at both ends and collapses leftovers', () => {
    const { text } = applyCharRefs('@路人甲, @小雪', entries);
    expect(text).toBe('1girl, long black hair, red eyes');
    const { text: t2 } = applyCharRefs('@小雪, @路人甲', entries);
    expect(t2).toBe('1girl, long black hair, red eyes');
  });

  it('replaces nl placeholders with the tag string when no nl sentence exists', () => {
    const { text } = applyCharRefs('@小雪 in a white dress', entries);
    expect(text).toBe('1girl, long black hair, red eyes in a white dress');
  });

  it('prefers the nl sentence for nl replacement when present', () => {
    const e = entry('小雪', { sex: '1girl' });
    e.nl = 'a petite girl with long black hair';
    const { text } = applyCharRefs('@小雪 sits by the window', [e], 'nl');
    expect(text).toBe('a petite girl with long black hair sits by the window');
  });

  it('nl mode falls back to the tag string when no nl sentence', () => {
    const { text } = applyCharRefs('@小雪 sits by the window', entries, 'nl');
    expect(text).toBe('1girl, long black hair, red eyes sits by the window');
  });
});

describe('parseConvertedTags', () => {
  it('parses structured per-character fields', () => {
    const raw = '{"阿黛尔":{"sex":"1girl","hair":"short silver hair","eyes":""}}';
    expect(parseConvertedTags(raw)).toEqual({
      阿黛尔: { sex: '1girl', hair: 'short silver hair' },
    });
  });

  it('tolerates code fences and surrounding prose, drops empty records', () => {
    const raw = '好的:\n```json\n{"阿黛尔":{"hair":"silver"},"空":{"":"  "}}\n```';
    expect(parseConvertedTags(raw)).toEqual({ 阿黛尔: { hair: 'silver' } });
  });

  it('sanitizes values with newlines or bbi tags, rejects non-object shapes', () => {
    const raw = '{"阿黛尔":{"hair":"long\\nblack"},"坏":{"eyes":"x<bbi_image>y"},"串":{"hair":"ok"}}';
    expect(parseConvertedTags(raw)).toEqual({ 串: { hair: 'ok' }, 阿黛尔: { hair: 'long black' } });
    expect(parseConvertedTags('{"阿黛尔":"plain string"}')).toEqual({});
    expect(parseConvertedTags('no json')).toEqual({});
  });
});

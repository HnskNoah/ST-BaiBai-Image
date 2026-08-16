import { describe, expect, it } from 'vitest';

import { normalizeCharTagStore } from '@/state/charTags';

describe('char tags store normalize', () => {
  it('keeps valid structured entries and normalizes fields', () => {
    const entries = normalizeCharTagStore({
      version: 2,
      entries: [
        {
          name: '阿黛尔',
          fields: { sex: '1girl', hair: ' short silver hair ' },
          source: 'book',
          desc: '银色短发',
        },
        { name: ' 铁匠老周 ', fields: { sex: '1boy' }, source: 'manual' },
      ],
    });
    expect(entries).toEqual([
      {
        name: '阿黛尔',
        fields: { sex: '1girl', hair: 'short silver hair', eyes: '', skin: '', body: '', extra: '', outfit: '' },
        raw: '',
        nl: '',
        source: 'book',
        desc: '银色短发',
        history: [],
      },
      {
        name: '铁匠老周',
        fields: { sex: '1boy', hair: '', eyes: '', skin: '', body: '', extra: '', outfit: '' },
        raw: '',
        nl: '',
        source: 'manual',
        desc: '',
        history: [],
      },
    ]);
  });

  it('migrates v1 legacy tags string into raw mode', () => {
    const entries = normalizeCharTagStore({
      version: 1,
      entries: [{ name: '旧角色', tags: '1girl, red eyes', source: 'book', desc: '红瞳' }],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].raw).toBe('1girl, red eyes');
    expect(entries[0].fields).toEqual({ sex: '', hair: '', eyes: '', skin: '', body: '', extra: '', outfit: '' });
    expect(entries[0].source).toBe('book');
    expect(entries[0].desc).toBe('红瞳');
  });

  it('drops entries without any usable content', () => {
    const entries = normalizeCharTagStore({
      version: 2,
      entries: [
        { name: '', fields: { sex: '1girl' } },
        { name: '空的', fields: {} },
        { name: '空白', fields: { hair: '   ' }, raw: ' ' },
        'not-an-object',
      ],
    });
    expect(entries).toEqual([]);
  });

  it('unknown source falls back to manual; history records are sanitized', () => {
    const entries = normalizeCharTagStore({
      version: 2,
      entries: [
        {
          name: '路人',
          fields: { sex: '1girl' },
          source: 'weird',
          history: [
            { field: 'hair', from: 'long', to: 'short', reason: '剪发', floor: 42, at: 1 },
            { field: 'bogus', from: 'x', to: 'y' },
            'junk',
          ],
        },
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe('manual');
    expect(entries[0].history).toEqual([
      { field: 'hair', from: 'long', to: 'short', reason: '剪发', floor: 42, at: 1 },
    ]);
  });

  it('dedupes by name, keeping the first occurrence', () => {
    const entries = normalizeCharTagStore({
      version: 2,
      entries: [
        { name: '阿黛尔', fields: { sex: 'a' }, source: 'book', desc: 'd1' },
        { name: '阿黛尔', fields: { sex: 'b' }, source: 'manual' },
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].fields.sex).toBe('a');
  });

  it('returns empty for malformed stores', () => {
    expect(normalizeCharTagStore(null)).toEqual([]);
    expect(normalizeCharTagStore({ version: 2 })).toEqual([]);
    expect(normalizeCharTagStore('junk')).toEqual([]);
  });
});

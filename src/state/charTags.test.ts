import { describe, expect, it } from 'vitest';

import { normalizeCharTagStore } from '@/state/charTags';

describe('char tags store normalize', () => {
  it('keeps valid entries and normalizes fields', () => {
    const entries = normalizeCharTagStore({
      version: 1,
      entries: [
        { name: '阿黛尔', tags: 'short silver hair, blue eyes', source: 'book', desc: '银色短发' },
        { name: ' 铁匠老周 ', tags: ' beard ', source: 'manual' },
      ],
    });
    expect(entries).toEqual([
      { name: '阿黛尔', tags: 'short silver hair, blue eyes', source: 'book', desc: '银色短发' },
      { name: '铁匠老周', tags: 'beard', source: 'manual', desc: '' },
    ]);
  });

  it('drops entries without name or tags, and unknown source falls back to manual', () => {
    const entries = normalizeCharTagStore({
      version: 1,
      entries: [
        { name: '', tags: 'x' },
        { name: '有名字', tags: ' ' },
        { name: '路人', tags: 'hoodie', source: 'weird' },
        'not-an-object',
      ],
    });
    expect(entries).toEqual([{ name: '路人', tags: 'hoodie', source: 'manual', desc: '' }]);
  });

  it('dedupes by name, keeping the first occurrence', () => {
    const entries = normalizeCharTagStore({
      version: 1,
      entries: [
        { name: '阿黛尔', tags: 'a', source: 'book', desc: 'd1' },
        { name: '阿黛尔', tags: 'b', source: 'manual', desc: '' },
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].tags).toBe('a');
  });

  it('returns empty for malformed stores', () => {
    expect(normalizeCharTagStore(null)).toEqual([]);
    expect(normalizeCharTagStore({ version: 1 })).toEqual([]);
    expect(normalizeCharTagStore('junk')).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';

import { buildAnchorText, parseConvertedTags, planCharAnchors } from '@/autoTag/charAnchors';
import type { BookRole } from '@/autoTag/bookMemory';
import type { CharTagEntry } from '@/state/charTags';

function entry(name: string, tags: string, source: CharTagEntry['source'] = 'book', desc = ''): CharTagEntry {
  return { name, tags, source, desc };
}

describe('planCharAnchors', () => {
  it('anchors existing entries; generates for book roles missing from the library', () => {
    const roles: BookRole[] = [
      { name: '阿黛尔', desc: '银色短发', isProtagonist: false },
      { name: '铁匠老周', desc: '络腮胡', isProtagonist: false },
      { name: '路人甲', desc: '', isProtagonist: false },
    ];
    const entries = [entry('阿黛尔', 'short silver hair', 'book', '银色短发')];
    const plan = planCharAnchors(roles, entries, '正文');
    expect(plan.anchorNames).toEqual(['阿黛尔']);
    expect(plan.toGenerate).toEqual([{ name: '铁匠老周', desc: '络腮胡' }]);
    // 柏宝书没记录外貌、库里也没有 → 既不锚定也不生成
    expect(plan.anchorNames).not.toContain('路人甲');
  });

  it('regenerates book entries whose recorded desc changed; keeps manual entries untouched', () => {
    const roles: BookRole[] = [
      { name: '阿黛尔', desc: '金色长直发', isProtagonist: false },
      { name: '老周', desc: '新外貌', isProtagonist: false },
    ];
    const entries = [
      entry('阿黛尔', 'short silver hair', 'book', '银色短发'),
      entry('老周', 'beard', 'manual', ''),
    ];
    const plan = planCharAnchors(roles, entries, '');
    expect(plan.toGenerate).toEqual([{ name: '阿黛尔', desc: '金色长直发' }]);
    expect(plan.anchorNames).toContain('老周');
  });

  it('anchors library entries not in the role reference but mentioned in the body text', () => {
    const roles: BookRole[] = [];
    const entries = [entry('神秘商人', 'hooded figure', 'manual'), entry('路人乙', 'x', 'manual')];
    const plan = planCharAnchors(roles, entries, '神秘商人掀开斗篷。');
    expect(plan.anchorNames).toEqual(['神秘商人']);
    expect(plan.toGenerate).toEqual([]);
  });

  it('does not double-count a role both in reference and library', () => {
    const roles: BookRole[] = [{ name: '阿黛尔', desc: '', isProtagonist: false }];
    const entries = [entry('阿黛尔', 'short silver hair', 'book', '银色短发')];
    const plan = planCharAnchors(roles, entries, '阿黛尔来了');
    expect(plan.anchorNames).toEqual(['阿黛尔']);
    // 柏宝书 desc 已被移除(空串)→ 不触发重转,沿用库条目
    expect(plan.toGenerate).toEqual([]);
  });
});

describe('buildAnchorText', () => {
  it('builds the verbatim-copy instruction block', () => {
    const text = buildAnchorText([entry('阿黛尔', 'short silver hair, blue eyes')]);
    expect(text).toContain('必须原样复制');
    expect(text).toContain('- 阿黛尔: short silver hair, blue eyes');
  });

  it('returns empty string for no anchors', () => {
    expect(buildAnchorText([])).toBe('');
  });
});

describe('parseConvertedTags', () => {
  it('parses a plain JSON object', () => {
    expect(parseConvertedTags('{"阿黛尔":"short silver hair, blue eyes"}')).toEqual({
      阿黛尔: 'short silver hair, blue eyes',
    });
  });

  it('tolerates code fences and surrounding prose', () => {
    const raw = '好的,转换结果如下:\n```json\n{"阿黛尔":"short silver hair"}\n```\n完毕。';
    expect(parseConvertedTags(raw)).toEqual({ 阿黛尔: 'short silver hair' });
  });

  it('strips thinking blocks and sanitizes values', () => {
    const raw = '<think>考虑一下</think>{"阿黛尔":"short silver hair\\nblue eyes","坏":"x<bbi_image>y","空":"  "}';
    const parsed = parseConvertedTags(raw);
    expect(parsed['阿黛尔']).toBe('short silver hair blue eyes');
    expect(parsed['坏']).toBeUndefined();
    expect(parsed['空']).toBeUndefined();
  });

  it('returns empty object for unparseable output', () => {
    expect(parseConvertedTags('没有 JSON')).toEqual({});
    expect(parseConvertedTags('[1,2,3]')).toEqual({});
  });
});

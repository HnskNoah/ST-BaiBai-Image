import { describe, expect, it } from 'vitest';

import { applyTagRules, newTagRule, normalizeTagRules, type TagRule } from '@/autoTag/tagRules';

/**
 * 联动加词(autoTag/tagRules.ts)的纯函数契约:
 * 整段精确匹配(「nude」不波及「nudity」)、大小写不敏感、单遍不链式、注入落目标串末尾
 * 且已在目标串里的词不重复加、不改原对象。
 *
 * runner 侧的接线(在 taglint **之后**注入、按当前出图渠道取规则表)没有 harness,
 * 由那段调用顺序的注释与这里的契约共同兜住。
 */

function rule(overrides: Partial<TagRule> = {}): TagRule {
  return {
    id: 'rule_1',
    name: '脱敏',
    triggers: ['nsfw'],
    add: ['uncensored'],
    target: 'positive',
    enabled: true,
    ...overrides,
  };
}

/** 用协议层形状的对象(多一个 position 字段),验证泛型保形。 */
function image(tag: string, negative = '') {
  return { tag, negative, position: 'p1' };
}

describe('applyTagRules', () => {
  it('命中即追加到正面末尾,保形且不改原对象', () => {
    const source = image('1girl, solo, nsfw');
    const { image: next, applied } = applyTagRules(source, [rule()]);

    expect(next.tag).toBe('1girl, solo, nsfw, uncensored');
    expect(next.position).toBe('p1'); // 泛型保形:位置等字段原样带过
    expect(applied).toEqual(['脱敏(nsfw): +uncensored → 正面']);
    expect(source.tag).toBe('1girl, solo, nsfw'); // 原对象一字不动
  });

  it('整段精确:「nsfw」不命中「nsfw body」,「nude」不命中「nudity」', () => {
    expect(applyTagRules(image('1girl, nsfw body'), [rule()]).applied).toEqual([]);
    expect(
      applyTagRules(image('1girl, nudity'), [rule({ triggers: ['nude'] })]).applied,
    ).toEqual([]);
    // 同名整段则命中(哪怕被空白包着)
    expect(
      applyTagRules(image('1girl,  nsfw '), [rule()]).image.tag,
    ).toBe('1girl, nsfw, uncensored');
  });

  it('大小写不敏感(触发与去重两侧)', () => {
    expect(applyTagRules(image('1girl, NSFW'), [rule()]).applied).toHaveLength(1);
    // 目标串里已有同词(不同大小写)→ 不重复注入,也就没有明细
    expect(applyTagRules(image('1girl, nsfw, Uncensored'), [rule()]).applied).toEqual([]);
  });

  it('多触发词任一命中;多个注入词逐个追加且保序', () => {
    const rules = [rule({ triggers: ['nsfw', 'explicit'], add: ['uncensored', 'mosaic censor'] })];
    const { image: next, applied } = applyTagRules(image('1girl, explicit'), rules);
    expect(next.tag).toBe('1girl, explicit, uncensored, mosaic censor');
    expect(applied).toHaveLength(1);
  });

  it('负面目标:注入到 negative 末尾(空串直接写入)', () => {
    const rules = [rule({ target: 'negative', triggers: ['nsfw'], add: ['mosaic'] })];
    const { image: next, applied } = applyTagRules(image('1girl, nsfw', ''), rules);
    expect(next.negative).toBe('mosaic');
    expect(next.tag).toBe('1girl, nsfw'); // 正面不动
    expect(applied).toEqual(['脱敏(nsfw): +mosaic → 负面']);
  });

  it('单遍:本次注入的词不参与后续规则匹配(规则不会互相点火)', () => {
    const chain = [
      rule({ id: 'a', name: 'A', triggers: ['nsfw'], add: ['uncensored'] }),
      rule({ id: 'b', name: 'B', triggers: ['uncensored'], add: ['不该出现'] }),
    ];
    const { image: next, applied } = applyTagRules(image('1girl, nsfw'), chain);
    expect(next.tag).toBe('1girl, nsfw, uncensored');
    expect(applied).toEqual(['A(nsfw): +uncensored → 正面']);
  });

  it('停用规则与空注入词跳过;全不命中时原样返回同一个对象', () => {
    expect(applyTagRules(image('1girl, nsfw'), [rule({ enabled: false })]).applied).toEqual([]);
    expect(applyTagRules(image('1girl, nsfw'), [rule({ add: [] })]).applied).toEqual([]);
    const source = image('1girl, solo');
    expect(applyTagRules(source, [rule()]).image).toBe(source);
  });
});

describe('normalizeTagRules', () => {
  it('脏数据逐项回退:非数组→空表、缺字段补默认、target/enabled 认白名单', () => {
    expect(normalizeTagRules(undefined)).toEqual([]);
    expect(normalizeTagRules('不是数组')).toEqual([]);
    const [kept] = normalizeTagRules([{ triggers: [' nsfw '], add: ['<uncensored>'], target: 'negative', enabled: false }]);
    expect(kept.triggers).toEqual(['nsfw']);
    expect(kept.add).toEqual(['uncensored']); // 剥尖括号:防伪造子标签
    expect(kept.target).toBe('negative');
    expect(kept.enabled).toBe(false);
    expect(kept.id).toMatch(/^rule_/);
    expect(kept.name).toBe('规则 1');
    // 脏 target 回落正面(不静默变成负面);脏 enabled 按 true(用户显式建的规则默认生效)
    const [dirty] = normalizeTagRules([{ target: '而不是', enabled: 'yes' }]);
    expect(dirty.target).toBe('positive');
    expect(dirty.enabled).toBe(true);
  });

  it('词表按小写去重且保留首现写法;空段与纯空白被剔除', () => {
    const [normalized] = normalizeTagRules([{ triggers: ['NSFW', 'nsfw', '', '  '], add: ['Uncensored', 'uncensored'] }]);
    expect(normalized.triggers).toEqual(['NSFW']);
    expect(normalized.add).toEqual(['Uncensored']);
  });
});

describe('newTagRule', () => {
  it('新建条目的 id 前缀与默认值(正面、启用、空词表)', () => {
    const fresh = newTagRule();
    expect(fresh.id).toMatch(/^rule_\d+_\d+$/);
    expect(fresh).toMatchObject({ name: '新规则', triggers: [], add: [], target: 'positive', enabled: true });
  });
});

import { describe, expect, it } from 'vitest';

import {
  collectChatu8ArtistRefs,
  collectChatu8VibeRefs,
  detectChatu8Artists,
  detectChatu8Vibes,
  importArtistsFromChatu8,
  planPrefixGroups,
  vibeFingerprint,
} from '@/backends/chatu8Vibe';

describe('collectChatu8VibeRefs', () => {
  it('收集预设与组内的 vibe 引用', () => {
    const refs = collectChatu8VibeRefs({
      vibePresets: {
        默认: { vibeDataId: 'cfgimg_a', strength: 0.7 },
        风格B: { vibeDataId: 'cfgimg_b', strength: 0.5 },
      },
      vibeGroups: {
        默认组: { vibes: [{ vibeDataId: 'cfgimg_c', strength: 0.6 }] },
        战斗组: {
          vibes: [
            { vibeDataId: 'cfgimg_d', strength: 0.4 },
            { vibeDataId: 'cfgimg_e', strength: 0.8 },
          ],
        },
      },
    });
    expect(refs.map(r => r.vibeDataId)).toEqual(['cfgimg_a', 'cfgimg_b', 'cfgimg_c', 'cfgimg_d', 'cfgimg_e']);
    expect(refs[0]).toMatchObject({ source: '默认', kind: 'preset', strength: 0.7 });
    expect(refs[2]).toMatchObject({ source: '默认组', kind: 'group', strength: 0.6 });
  });

  it('同一 vibeDataId 多处出现时按预设优先去重', () => {
    const refs = collectChatu8VibeRefs({
      vibePresets: { 我的预设: { vibeDataId: 'cfgimg_x', strength: 0.9 } },
      vibeGroups: { 组A: { vibes: [{ vibeDataId: 'cfgimg_x', strength: 0.3 }] } },
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kind: 'preset', source: '我的预设', strength: 0.9 });
  });

  it('容错:非对象/缺字段/非法强度', () => {
    expect(collectChatu8VibeRefs(null)).toEqual([]);
    expect(collectChatu8VibeRefs('junk')).toEqual([]);
    const refs = collectChatu8VibeRefs({
      vibePresets: { 坏: { vibeDataId: 123 }, 好: { vibeDataId: 'cfgimg_ok', strength: 'abc' } },
      vibeGroups: { 空组: { vibes: 'not-array' } },
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ vibeDataId: 'cfgimg_ok', strength: 0.6 });
  });
});

describe('detectChatu8Vibes', () => {
  it('未安装/无设置时 found=false', () => {
    expect(detectChatu8Vibes(undefined).found).toBe(false);
    expect(detectChatu8Vibes(null).found).toBe(false);
    expect(detectChatu8Vibes('junk').found).toBe(false);
  });

  it('统计预设与组内 vibe 数(已去重)', () => {
    const info = detectChatu8Vibes({
      vibePresets: { 默认: { vibeDataId: 'a' }, 风格B: { vibeDataId: 'b' } },
      vibeGroups: { 组1: { vibes: [{ vibeDataId: 'b' }, { vibeDataId: 'c' }] } },
    });
    expect(info).toEqual({ found: true, total: 3, presets: 2, groups: 1 });
  });

  it('有设置但没 vibe → found=true,total=0', () => {
    const info = detectChatu8Vibes({ someOtherSetting: 1 });
    expect(info).toEqual({ found: true, total: 0, presets: 0, groups: 0 });
  });
});

describe('planPrefixGroups', () => {
  const vibe = (id: string, name: string, group = '') => ({ id, name, group });

  it('把「组名 · 原名」前缀还原成分组', () => {
    const plans = planPrefixGroups([
      vibe('1', '战斗组 · 剑光'),
      vibe('2', '战斗组 · 火焰'),
      vibe('3', '日常组 · 咖啡'),
    ]);
    expect(plans).toEqual([
      { id: '1', group: '战斗组', name: '剑光' },
      { id: '2', group: '战斗组', name: '火焰' },
      { id: '3', group: '日常组', name: '咖啡' },
    ]);
  });

  it('不动已分好组的条目', () => {
    expect(planPrefixGroups([vibe('1', '战斗组 · 剑光', '我的组')])).toEqual([]);
  });

  it('没有前缀的条目不参与', () => {
    expect(planPrefixGroups([vibe('1', '剑光'), vibe('2', '一个·没有空格的名字')])).toEqual([]);
  });

  it('前缀或余名为空时跳过,不产出空组名', () => {
    expect(planPrefixGroups([vibe('1', ' · 剑光'), vibe('2', '战斗组 · ')])).toEqual([]);
  });

  it('只取第一个分隔符,余下的分隔符留在名字里', () => {
    expect(planPrefixGroups([vibe('1', '战斗组 · 剑光 · 二段')])).toEqual([
      { id: '1', group: '战斗组', name: '剑光 · 二段' },
    ]);
  });
});

describe('vibeFingerprint', () => {
  it('同内容同指纹,与 key 顺序无关', () => {
    const a = vibeFingerprint({
      v3: { encoding: 'AAA', infoExtracted: 1 },
      'v4-5full': { encoding: 'BBB', infoExtracted: 1 },
    });
    const b = vibeFingerprint({
      'v4-5full': { encoding: 'BBB', infoExtracted: 1 },
      v3: { encoding: 'AAA', infoExtracted: 1 },
    });
    expect(a).toBe(b);
  });

  it('不同编码不同指纹', () => {
    const a = vibeFingerprint({ v3: { encoding: 'AAA', infoExtracted: 1 } });
    const b = vibeFingerprint({ v3: { encoding: 'CCC', infoExtracted: 1 } });
    expect(a).not.toBe(b);
  });
});

describe('st-chatu8 artist migration', () => {
  const source = {
    yushe: {
      Default: { fixedPrompt: '', fixedPrompt_end: '', negativePrompt: 'ignored' },
      Painter: { fixedPrompt: 'artist:a', fixedPrompt_end: 'style:b', negativePrompt: 'bad' },
      SharedSDPreset: { fixedPrompt: 'score_9', fixedPrompt_end: '' },
      Broken: null,
    },
    yusheid_novelai: 'Painter',
  };

  it('collects the whole shared preset library and merges both positive prompt positions', () => {
    expect(collectChatu8ArtistRefs(source)).toEqual([
      { source: 'Default', prompt: '', active: false },
      { source: 'Painter', prompt: 'artist:a, style:b', active: true },
      { source: 'SharedSDPreset', prompt: 'score_9', active: false },
    ]);
  });

  it('detects source settings independently from preset count', () => {
    expect(detectChatu8Artists(undefined)).toEqual({ found: false, total: 0 });
    expect(detectChatu8Artists({ yushe: {} })).toEqual({ found: true, total: 0 });
    expect(detectChatu8Artists(source)).toEqual({ found: true, total: 3 });
  });

  it('imports every valid preset, including empty and presets shared with other backends', () => {
    const result = importArtistsFromChatu8([], source);
    expect(result.found).toBe(true);
    expect(result.imported).toBe(3);
    expect(result.duplicates).toBe(0);
    expect(result.artistPresets.map(p => [p.name, p.prompt])).toEqual([
      ['Default', ''],
      ['Painter', 'artist:a, style:b'],
      ['SharedSDPreset', 'score_9'],
    ]);
    expect(result.artistPresets.every(p => p.id.startsWith('art_'))).toBe(true);
    expect(result.activeArtistId).toBe(result.artistPresets[1].id);
  });

  it('deduplicates by trimmed name and prompt and maps the active source preset to an existing id', () => {
    const existing = [{ id: 'art_existing', name: ' Painter ', prompt: 'artist:a, style:b ' }];
    const result = importArtistsFromChatu8(existing, source);
    expect(result.imported).toBe(2);
    expect(result.duplicates).toBe(1);
    expect(result.activeArtistId).toBe('art_existing');
  });

  it('does not collapse different names with identical prompt content', () => {
    const result = importArtistsFromChatu8([], {
      yushe: {
        A: { fixedPrompt: 'artist:a' },
        B: { fixedPrompt: 'artist:a' },
      },
    });
    expect(result.imported).toBe(2);
  });
});

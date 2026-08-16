import { describe, expect, it } from 'vitest';

import { collectChatu8VibeRefs, detectChatu8Vibes, vibeFingerprint } from '@/backends/chatu8Vibe';

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

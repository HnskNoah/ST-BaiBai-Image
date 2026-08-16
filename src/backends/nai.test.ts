import { describe, expect, it } from 'vitest';

import {
  applyVibes,
  buildNaiParameters,
  fullNegativePrompt,
  fullPositivePrompt,
  naiEndpoint,
  naiRandomSeed,
  parseNaiv4vibe,
  parseResolution,
  skipCfgAboveSigma,
  ucPresetNames,
  unzipNaiImage,
  vibeModelKey,
  NaiError,
} from '@/backends/nai';
import type { NaiSettings, NaiVibe } from '@/state/settings';
import { strToU8, zipSync } from 'fflate';

function nai(overrides: Partial<NaiSettings> = {}): NaiSettings {
  return {
    url: 'https://image.novelai.net',
    qualityTags: '',
    negativePrompt: '',
    resolution: '832×1216',
    portraitSize: '832×1216',
    landscapeSize: '1216×832',
    key: 'nai-test',
    model: 'nai-diffusion-4-5-full',
    sampler: 'k_euler',
    steps: 28,
    scale: 5,
    cfgRescale: 0,
    noiseSchedule: 'karras',
    seed: 0,
    ucPreset: 'Heavy',
    qualityToggle: true,
    varietyBoost: true,
    normalizeRefStrength: true,
    concurrency: 1,
    vibes: [],
    ...overrides,
  };
}

function vibe(overrides: Partial<NaiVibe> = {}): NaiVibe {
  return {
    id: 'v1',
    name: '测试Vibe',
    image: 'aW1hZ2U=',
    thumbnail: '',
    encodings: { 'v4-5full': { encoding: 'ZW5jb2Rpbmc=', infoExtracted: 1 } },
    strength: 0.6,
    enabled: true,
    ...overrides,
  };
}

describe('naiEndpoint', () => {
  it('自动补 /ai 前缀', () => {
    expect(naiEndpoint('https://image.novelai.net', 'generate-image')).toBe(
      'https://image.novelai.net/ai/generate-image',
    );
    expect(naiEndpoint('https://mirror.example.com/', 'encode-vibe')).toBe(
      'https://mirror.example.com/ai/encode-vibe',
    );
  });

  it('base 已是完整端点时原样使用', () => {
    expect(naiEndpoint('https://x.com/proxy/ai/generate-image', 'generate-image')).toBe(
      'https://x.com/proxy/ai/generate-image',
    );
  });

  it('空地址报错', () => {
    expect(() => naiEndpoint('  ', 'generate-image')).toThrow(NaiError);
  });
});

describe('parseResolution', () => {
  it('支持 × / x / * 分隔', () => {
    expect(parseResolution('832×1216')).toEqual({ width: 832, height: 1216 });
    expect(parseResolution('1024x1024')).toEqual({ width: 1024, height: 1024 });
  });

  it('拒绝非 64 倍数与非法格式', () => {
    expect(() => parseResolution('830×1216')).toThrow(/64/);
    expect(() => parseResolution('')).toThrow(NaiError);
    expect(() => parseResolution('4096×4096')).toThrow(/范围/);
  });
});

describe('提示词拼装', () => {
  it('qualityToggle 开且无自定义质量词时用模型内置质量词', () => {
    const full = fullPositivePrompt(nai(), '1girl, sitting');
    expect(full).toBe('very aesthetic, masterpiece, no text, 1girl, sitting');
  });

  it('自定义质量词优先于内置', () => {
    const full = fullPositivePrompt(nai({ qualityTags: 'best quality' }), '1girl');
    expect(full).toBe('best quality, 1girl');
  });

  it('qualityToggle 关时不加质量词', () => {
    expect(fullPositivePrompt(nai({ qualityToggle: false }), '1girl')).toBe('1girl');
  });

  it('负面 = 用户负面 + 预设', () => {
    const neg = fullNegativePrompt(nai({ negativePrompt: 'bad hands' }));
    expect(neg.startsWith('bad hands, ')).toBe(true);
    expect(neg).toContain('worst quality');
  });

  it('负面预设「无」时只用用户负面', () => {
    expect(fullNegativePrompt(nai({ ucPreset: '无', negativePrompt: 'bad hands' }))).toBe('bad hands');
  });

  it('ucPresetNames 按模型给预设,4-5-full 含 Furry Focus', () => {
    expect(ucPresetNames('nai-diffusion-4-5-full')).toContain('Furry Focus');
    expect(ucPresetNames('nai-diffusion-4-full')).not.toContain('Furry Focus');
    expect(ucPresetNames('nai-diffusion-3')).toContain('Human Focus');
  });
});

describe('buildNaiParameters', () => {
  it('v4 系带 v4_prompt 结构', () => {
    const p = buildNaiParameters(nai(), { prompt: '1girl', seed: 42 });
    expect(p.seed).toBe(42);
    expect(p.width).toBe(832);
    expect(p.height).toBe(1216);
    const v4 = p.v4_prompt as { caption: { base_caption: string }; use_order: boolean };
    expect(v4.caption.base_caption).toContain('1girl');
    expect(v4.use_order).toBe(true);
    expect(p.reference_image_multiple_cached).toEqual([]);
    expect(p.v4_negative_prompt).toBeTruthy();
  });

  it('NAI3 不带 v4 结构,带原图参考数组与 sm 开关', () => {
    const p = buildNaiParameters(nai({ model: 'nai-diffusion-3' }), { prompt: '1girl', seed: 1 });
    expect(p.v4_prompt).toBeUndefined();
    expect(p.reference_image_multiple).toEqual([]);
    expect(p.reference_information_extracted_multiple).toEqual([]);
    expect(p.sm).toBe(false);
    expect(p.reference_image_multiple_cached).toBeUndefined();
  });

  it('k_euler_ancestral 附加 brownian 修正', () => {
    const p = buildNaiParameters(nai({ sampler: 'k_euler_ancestral' }), { prompt: 'x', seed: 1 });
    expect(p.prefer_brownian).toBe(true);
    expect(p.deliberate_euler_ancestral_bug).toBe(false);
  });

  it('横屏画面取横屏尺寸,skip_cfg_above_sigma 随像素量同步变化', () => {
    const portrait = buildNaiParameters(nai(), { prompt: '1girl', seed: 1 });
    const landscape = buildNaiParameters(nai(), { prompt: '2girls', seed: 1, size: 'landscape' });
    expect(landscape.width).toBe(1216);
    expect(landscape.height).toBe(832);
    // 832×1216 与 1216×832 像素量相同,sigma 也应相同(证明它确实按尺寸推导)
    expect(landscape.skip_cfg_above_sigma).toBe(portrait.skip_cfg_above_sigma);

    const bigLandscape = buildNaiParameters(nai({ landscapeSize: '1536×1024' }), {
      prompt: '2girls',
      seed: 1,
      size: 'landscape',
    });
    expect(bigLandscape.width).toBe(1536);
    expect(Number(bigLandscape.skip_cfg_above_sigma)).toBeGreaterThan(
      Number(portrait.skip_cfg_above_sigma),
    );
  });

  it('缺 size 时按竖屏出图(与改动前的固定默认一致)', () => {
    const p = buildNaiParameters(nai(), { prompt: '1girl', seed: 1 });
    expect(p.width).toBe(832);
    expect(p.height).toBe(1216);
  });

  it('对应方向未填时回落内置竖屏默认', () => {
    const p = buildNaiParameters(nai({ landscapeSize: '' }), { prompt: 'x', seed: 1, size: 'landscape' });
    expect(p.width).toBe(832);
    expect(p.height).toBe(1216);
  });

  it('固定种子优先于随机', () => {
    const p = buildNaiParameters(nai({ seed: 123 }), { prompt: 'x' });
    expect(p.seed).toBe(123);
    const p2 = buildNaiParameters(nai({ seed: 123 }), { prompt: 'x', seed: 7 });
    expect(p2.seed).toBe(7);
  });
});

describe('skipCfgAboveSigma', () => {
  it('关 variety 时为 null', () => {
    expect(skipCfgAboveSigma(832, 1216, 'nai-diffusion-4-5-full', false)).toBeNull();
  });

  it('4.5 用 58,其余用 19', () => {
    const v45 = skipCfgAboveSigma(1024, 1024, 'nai-diffusion-4-5-full', true)!;
    const v4 = skipCfgAboveSigma(1024, 1024, 'nai-diffusion-4-full', true)!;
    expect(v45 / v4).toBeCloseTo(58 / 19, 5);
  });
});

describe('applyVibes', () => {
  it('NAI4/4.5:编码数据进 cached,强度并进 strength 数组', () => {
    const params = buildNaiParameters(nai(), { prompt: 'x', seed: 1 });
    const skipped = applyVibes(params, nai({ vibes: [vibe()] }));
    expect(skipped).toEqual([]);
    const cached = params.reference_image_multiple_cached as { cache_secret_key: string; data: string }[];
    expect(cached).toHaveLength(1);
    expect(cached[0].data).toBe('ZW5jb2Rpbmc=');
    expect(cached[0].cache_secret_key).toBeTruthy();
    expect(params.reference_strength_multiple).toEqual([0.6]);
  });

  it('缺当前模型编码的 vibe 被跳过并返回名字', () => {
    const params = buildNaiParameters(nai(), { prompt: 'x', seed: 1 });
    const skipped = applyVibes(
      params,
      nai({ vibes: [vibe({ name: '旧模型Vibe', encodings: { v3: { encoding: 'eQ==', infoExtracted: 1 } } })] }),
    );
    expect(skipped).toEqual(['旧模型Vibe']);
    expect(params.reference_image_multiple_cached).toEqual([]);
  });

  it('强度总和超过 1 且开归一化时按比例压回 1', () => {
    const params = buildNaiParameters(nai(), { prompt: 'x', seed: 1 });
    applyVibes(
      params,
      nai({
        vibes: [vibe({ id: 'a', strength: 0.8 }), vibe({ id: 'b', strength: 0.6 })],
      }),
    );
    const strengths = params.reference_strength_multiple as number[];
    expect(strengths[0] + strengths[1]).toBeCloseTo(1, 6);
  });

  it('NAI3:参考原图进 reference_image_multiple', () => {
    const settings = nai({ model: 'nai-diffusion-3', vibes: [vibe()] });
    const params = buildNaiParameters(settings, { prompt: 'x', seed: 1 });
    const skipped = applyVibes(params, settings);
    expect(skipped).toEqual([]);
    expect(params.reference_image_multiple).toEqual(['aW1hZ2U=']);
    expect(params.reference_information_extracted_multiple).toEqual([1]);
    expect(params.reference_strength_multiple).toEqual([0.6]);
  });

  it('未启用的 vibe 不参与', () => {
    const params = buildNaiParameters(nai(), { prompt: 'x', seed: 1 });
    applyVibes(params, nai({ vibes: [vibe({ enabled: false })] }));
    expect(params.reference_image_multiple_cached).toEqual([]);
  });
});

describe('vibeModelKey', () => {
  it('按模型映射官方 key', () => {
    expect(vibeModelKey('nai-diffusion-4-5-full')).toBe('v4-5full');
    expect(vibeModelKey('nai-diffusion-4-5-curated')).toBe('v4-5curated');
    expect(vibeModelKey('nai-diffusion-4-full')).toBe('v4full');
    expect(vibeModelKey('nai-diffusion-4-curated-preview')).toBe('v4curated');
    expect(vibeModelKey('nai-diffusion-3')).toBe('v3');
  });
});

describe('parseNaiv4vibe', () => {
  it('解析官方格式', () => {
    const text = JSON.stringify({
      identifier: 'novelai-vibe-transfer',
      version: 1,
      image: 'aW1hZ2U=',
      name: 'abc123-def456',
      thumbnail: 'data:image/png;base64,xx',
      encodings: {
        'v4-5full': {
          k: { encoding: 'ZW5jb2Rpbmc=', params: { information_extracted: 1 } },
        },
      },
      importInfo: { model: 'nai-diffusion-4-5-full', information_extracted: 1, strength: 0.7 },
    });
    const v = parseNaiv4vibe(text);
    expect(v.name).toBe('abc123-def456');
    expect(v.encodings['v4-5full'].encoding).toBe('ZW5jb2Rpbmc=');
    expect(v.strength).toBe(0.7);
  });

  it('拒绝非 vibe JSON', () => {
    expect(() => parseNaiv4vibe('{"foo":1}')).toThrow(/标识/);
    expect(() => parseNaiv4vibe('not json')).toThrow(NaiError);
  });
});

describe('unzipNaiImage', () => {
  it('解出 zip 内第一张图', () => {
    const zipped = zipSync({ 'image_0.png': strToU8('fake-png-bytes') });
    const { base64, filename } = unzipNaiImage(zipped.buffer as ArrayBuffer);
    expect(filename).toBe('image_0.png');
    expect(atob(base64)).toBe('fake-png-bytes');
  });

  it('非 zip 数据报友好错误', () => {
    expect(() => unzipNaiImage(strToU8('not a zip').buffer as ArrayBuffer)).toThrow(NaiError);
  });
});

describe('naiRandomSeed', () => {
  it('32 位无符号整数', () => {
    const s = naiRandomSeed();
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThan(2 ** 32);
  });
});

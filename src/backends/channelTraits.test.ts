import { describe, expect, it } from 'vitest';

import {
  activeChannelTraits,
  channelTraits,
  type ChannelTraitsInput,
  type SpecFamily,
} from '@/backends/channelTraits';
import { activeComfyPreset, settings } from '@/state/settings';

/**
 * 判据层的唯一来源(见 channelTraits.ts):渠道差异只在这张表里表达,消费方(prompt.ts 的
 * 协议与规范、runner.ts 的验收门与 taglint、generate.ts 的出口 opts)一律读表、
 * 不再问「渠道是谁」。
 * channelTraits 是纯函数,直接传参断言;activeChannelTraits 读 settings,那组用例自己存回。
 */
function input(overrides: Partial<ChannelTraitsInput> = {}): ChannelTraitsInput {
  return {
    naiModel: 'nai-diffusion-5-full',
    naiNaturalLanguage: true,
    comfyNaturalLanguage: false,
    orientationLock: 'auto',
    ...overrides,
  };
}

describe('channelTraits', () => {
  it('latent:恒单串 + nl 族,与 NAI 模型名无关', () => {
    // latent 的 model 字段存的就是 NAI 名,但站点不收双层结构,故 4.5/V5 也不开 charPrompts
    for (const naiModel of ['nai-diffusion-4-5-full', 'nai-diffusion-5-full', 'nai-diffusion-3']) {
      const traits = channelTraits('latent', input({ naiModel }));
      expect(traits.spec).toBe('latent');
      expect(traits.thinking).toBe('latent');
      expect(traits.lintMode).toBe('latent');
      expect(traits.charPrompts).toBe(false);
      // 站点底层是 Anima 系(Qwen 编码器),吃自然语言:nl 恒开,不跟任何开关
      expect(traits.nlAlways).toBe(true);
      expect(traits.nl).toBe(true);
      expect(channelTraits('latent', input({ naiModel, naiNaturalLanguage: false })).nl).toBe(true);
      // 站点有原生 negativePrompt 字段,画面级负面随每张图下发
      expect(traits.frameNegative).toBe(true);
      // 出口:走 NAI 机器,但发扁平串 + 分辨率枚举,不吃 64 倍数校验,429=配额耗尽不退避
      expect(traits.usesNaiMachine).toBe(true);
      expect(traits.flatPrompt).toBe(true);
      expect(traits.sizeEncoding).toBe('orientationEnum');
      expect(traits.allowNon64Size).toBe(true);
      expect(traits.noRetry429).toBe(true);
    }
  });

  it('nai 4.5/V5:走 Base + Character Prompts 那一份', () => {
    for (const naiModel of ['nai-diffusion-5-full', 'nai-diffusion-4-5-curated']) {
      const traits = channelTraits('nai', input({ naiModel }));
      expect(traits.spec).toBe('naiV5');
      expect(traits.thinking).toBe('naiV5');
      expect(traits.lintMode).toBe('v5');
      expect(traits.charPrompts).toBe(true);
      expect(traits.nlAlways).toBe(false);
      expect(traits.frameNegative).toBe(false);
      // 官方协议收数字对宽高 + v4_prompt 双层结构
      expect(traits.usesNaiMachine).toBe(true);
      expect(traits.flatPrompt).toBe(false);
      expect(traits.sizeEncoding).toBe('pixels');
      expect(traits.allowNon64Size).toBe(false);
      expect(traits.noRetry429).toBe(false);
    }
  });

  it('nai 4.5/V5:nl 跟渠道的「生成自然语言」开关', () => {
    expect(channelTraits('nai', input({ naiNaturalLanguage: true })).nl).toBe(true);
    expect(channelTraits('nai', input({ naiNaturalLanguage: false })).nl).toBe(false);
  });

  it('nai 已下线模型:遗留单串分支,与 latent 同走 latent 守卫规则', () => {
    // 模型列表收窄后 NAI 自身走不到这一支,留作回归锁(见 prompt.test.ts)
    for (const naiModel of ['nai-diffusion-4-full', 'nai-diffusion-3']) {
      const traits = channelTraits('nai', input({ naiModel }));
      expect(traits.spec).toBe('naiSingle');
      expect(traits.thinking).toBe('naiSingle');
      expect(traits.lintMode).toBe('latent');
      expect(traits.charPrompts).toBe(false);
      // 单串分支没有 nl 键,渠道开关对它不起作用(与 latent 的恒开不同源)
      expect(traits.nl).toBe(false);
      expect(channelTraits('nai', input({ naiModel, naiNaturalLanguage: true })).nl).toBe(false);
    }
  });

  it('comfyui:规范与思维链都取工作流那份,nl 跟工作流开关', () => {
    const traits = channelTraits('comfyui', input());
    expect(traits.spec).toBe('comfy');
    expect(traits.thinking).toBe('comfy');
    expect(traits.lintMode).toBe('comfyui');
    expect(traits.charPrompts).toBe(false);
    // 负面跟工作流有没有 %negative_prompt%——运行时判据,不在表里
    expect(traits.nlAlways).toBe(false);
    expect(traits.frameNegative).toBe(false);
    expect(traits.usesNaiMachine).toBe(false);
    // NAI 的「生成自然语言」开关不得漏到 ComfyUI
    expect(traits.nl).toBe(false);
    expect(channelTraits('comfyui', input({ comfyNaturalLanguage: true })).nl).toBe(true);
  });

  it('webui(存量类型):不下发规范,思维链回落 comfy 那份', () => {
    const traits = channelTraits('webui', input());
    expect(traits.spec).toBeNull();
    expect(traits.thinking).toBe('comfy');
    expect(traits.lintMode).toBe('comfyui');
    expect(traits.charPrompts).toBe(false);
    expect(traits.nl).toBe(false);
  });

  it('lintMode 恒由 spec 族派生:规范说单串就不会被按 V5 剥词', () => {
    // 旧写法把「取哪份规范」与「用哪套守卫」分开算,靠注释叮嘱顺序承重;
    // 这条锁死派生关系,任何渠道都不得出现规范与守卫不同族。
    const expected: Record<string, string> = {
      naiV5: 'v5',
      latent: 'latent',
      naiSingle: 'latent',
      comfy: 'comfyui',
    };
    for (const channel of ['latent', 'nai', 'comfyui', 'webui'] as const) {
      for (const naiModel of ['nai-diffusion-5-full', 'nai-diffusion-4-full']) {
        const traits = channelTraits(channel, input({ naiModel }));
        const family = (traits.spec ?? traits.thinking) as SpecFamily;
        expect(traits.lintMode).toBe(expected[family]);
      }
    }
  });

  it('画幅锁:auto 记 null,锁定值原样透出(各渠道同一口径)', () => {
    expect(channelTraits('nai', input({ orientationLock: 'auto' })).lockedSize).toBeNull();
    for (const channel of ['nai', 'latent', 'comfyui', 'webui'] as const) {
      expect(channelTraits(channel, input({ orientationLock: 'portrait' })).lockedSize).toBe('portrait');
      expect(channelTraits(channel, input({ orientationLock: 'landscape' })).lockedSize).toBe(
        'landscape',
      );
    }
  });
});

describe('activeChannelTraits', () => {
  // 读 settings 的那层薄壳:上游同位置的 autoTagProfile 断言搬到这里(判据合成一处后,
  // 「按当前后端与其开关算一次」这件事由本函数承担)。
  function snapshot() {
    const preset = activeComfyPreset();
    const saved = {
      backend: settings.defaultBackend,
      model: settings.nai.model,
      naiNl: settings.nai.naturalLanguage,
      naiLock: settings.nai.orientationLock,
      presetNl: preset.naturalLanguage,
      presetLock: preset.orientationLock,
    };
    return {
      preset,
      restore() {
        settings.defaultBackend = saved.backend;
        settings.nai.model = saved.model;
        settings.nai.naturalLanguage = saved.naiNl;
        settings.nai.orientationLock = saved.naiLock;
        preset.naturalLanguage = saved.presetNl;
        preset.orientationLock = saved.presetLock;
      },
    };
  }

  it('按当前后端与其开关算一次,写协议与 runner 验收共用这一份', () => {
    const state = snapshot();
    try {
      settings.defaultBackend = 'nai';
      settings.nai.model = 'nai-diffusion-4-5-full';
      settings.nai.naturalLanguage = true;
      settings.nai.orientationLock = 'auto';
      expect(activeChannelTraits()).toMatchObject({
        channel: 'nai',
        charPrompts: true,
        nl: true,
        lockedSize: null,
      });

      settings.nai.naturalLanguage = false;
      settings.nai.orientationLock = 'portrait';
      expect(activeChannelTraits()).toMatchObject({ charPrompts: true, nl: false, lockedSize: 'portrait' });

      // 单串分支(NAI4)的协议本来就不写 nl,开关对它不起作用
      settings.nai.model = 'nai-diffusion-4-full';
      settings.nai.naturalLanguage = true;
      expect(activeChannelTraits()).toMatchObject({ charPrompts: false, nl: false });

      // ComfyUI:自然语言与画幅锁都取当前工作流,NAI 面板那两个开关一律不看
      settings.defaultBackend = 'comfyui';
      state.preset.naturalLanguage = true;
      state.preset.orientationLock = 'landscape';
      expect(activeChannelTraits()).toMatchObject({
        channel: 'comfyui',
        charPrompts: false,
        nl: true,
        lockedSize: 'landscape',
      });

      state.preset.naturalLanguage = false;
      state.preset.orientationLock = 'auto';
      expect(activeChannelTraits()).toMatchObject({ nl: false, lockedSize: null });

      // latent:恒开 nl,且不吃 NAI 面板的画幅锁(activeOrientationLock 对 latent 返回 auto)
      settings.defaultBackend = 'latent';
      settings.nai.naturalLanguage = false;
      settings.nai.orientationLock = 'landscape';
      expect(activeChannelTraits()).toMatchObject({
        channel: 'latent',
        nl: true,
        lockedSize: null,
        flatPrompt: true,
      });
    } finally {
      state.restore();
    }
  });
});

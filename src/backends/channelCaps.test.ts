import { describe, expect, it } from 'vitest';

import { channelCaps, type SpecFamily } from '@/backends/channelCaps';

/**
 * 判据层的唯一来源(见 channelCaps.ts):渠道差异只在这张表里表达,消费方(prompt.ts 的
 * 协议与规范、runner.ts 的验收门与 taglint)一律读表、不再问「渠道是谁」。
 * 纯函数,故直接传参断言,不必改全局 settings 再还原。
 */
describe('channelCaps', () => {
  it('latent:恒单串 + nl 族,与 NAI 模型名无关', () => {
    // latent 的 model 字段存的就是 NAI 名,但站点不收双层结构,故 4.5/V5 也不开 charPrompts
    for (const model of ['nai-diffusion-4-5-full', 'nai-diffusion-5-full', 'nai-diffusion-3']) {
      const caps = channelCaps('latent', model);
      expect(caps.spec).toBe('latent');
      expect(caps.thinking).toBe('latent');
      expect(caps.lintMode).toBe('latent');
      expect(caps.charPrompts).toBe(false);
      // 站点底层是 Anima 系(Qwen 编码器),吃自然语言:nl 恒开,不跟任何开关
      expect(caps.nlAlways).toBe(true);
      // 站点有原生 negativePrompt 字段,画面级负面随每张图下发
      expect(caps.frameNegative).toBe(true);
    }
  });

  it('nai 4.5/V5:走 Base + Character Prompts 那一份', () => {
    for (const model of ['nai-diffusion-5-full', 'nai-diffusion-4-5-curated']) {
      const caps = channelCaps('nai', model);
      expect(caps.spec).toBe('naiV5');
      expect(caps.thinking).toBe('naiV5');
      expect(caps.lintMode).toBe('v5');
      expect(caps.charPrompts).toBe(true);
      expect(caps.nlAlways).toBe(false);
      expect(caps.frameNegative).toBe(false);
    }
  });

  it('nai 已下线模型:遗留单串分支,与 latent 同走 latent 守卫规则', () => {
    // 模型列表收窄后 NAI 自身走不到这一支,留作回归锁(见 prompt.test.ts)
    for (const model of ['nai-diffusion-4-full', 'nai-diffusion-3']) {
      const caps = channelCaps('nai', model);
      expect(caps.spec).toBe('naiSingle');
      expect(caps.thinking).toBe('naiSingle');
      expect(caps.lintMode).toBe('latent');
      expect(caps.charPrompts).toBe(false);
    }
  });

  it('comfyui:规范与思维链都取工作流那份,负面留给运行时判', () => {
    const caps = channelCaps('comfyui', 'nai-diffusion-5-full');
    expect(caps.spec).toBe('comfy');
    expect(caps.thinking).toBe('comfy');
    expect(caps.lintMode).toBe('comfyui');
    expect(caps.charPrompts).toBe(false);
    // nl 跟当前工作流的开关、负面跟工作流有没有 %negative_prompt%——都是运行时判据,不在表里
    expect(caps.nlAlways).toBe(false);
    expect(caps.frameNegative).toBe(false);
  });

  it('webui(存量类型):不下发规范,思维链回落 comfy 那份', () => {
    const caps = channelCaps('webui', 'nai-diffusion-5-full');
    expect(caps.spec).toBeNull();
    expect(caps.thinking).toBe('comfy');
    expect(caps.lintMode).toBe('comfyui');
    expect(caps.charPrompts).toBe(false);
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
      for (const model of ['nai-diffusion-5-full', 'nai-diffusion-4-full']) {
        const caps = channelCaps(channel, model);
        const family = (caps.spec ?? caps.thinking) as SpecFamily;
        expect(caps.lintMode).toBe(expected[family]);
      }
    }
  });
});

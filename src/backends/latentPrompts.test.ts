import { describe, expect, it } from 'vitest';

import { DEFAULT_LATENT_SPEC, DEFAULT_LATENT_THINKING } from '@/backends/latentPrompts';
import { DEFAULT_NAI_SPEC, DEFAULT_NAI_THINKING } from '@/state/settings';

/**
 * latent 的内置文本与 NAI 的那两份**必须各归各**(见 latentPrompts.ts 文件头)。
 * 这两条锁的是分裂本身:一旦有人为了省一份文本把它们合回同一个常量,或把上游带宏的
 * NAI 文本接回 latent 的回落链,这里就红。
 */
describe('latentPrompts', () => {
  const NL_MACRO = /\{\{[#^/]nl\}\}/;

  it('不带自然语言条件段宏:latent 侧没有 expandNlSections 接线,宏会原样发给站点', () => {
    // latent 恒吃自然语言(caps.nlAlways),nl 段无条件写死在文本里,不需要条件段。
    // 上游 0.3.2 给 DEFAULT_NAI_* 加了 {{#nl}}/{{^nl}} 宏——那份文本一旦经回落链流到
    // latent,花括号会直接进请求(这两类文本不经 ST 宏替换,宿主也不会吃掉它)。
    expect(DEFAULT_LATENT_SPEC).not.toMatch(NL_MACRO);
    expect(DEFAULT_LATENT_THINKING).not.toMatch(NL_MACRO);
  });

  it('与 NAI 的内置文本不再同源', () => {
    expect(DEFAULT_LATENT_SPEC).not.toBe(DEFAULT_NAI_SPEC);
    expect(DEFAULT_LATENT_THINKING).not.toBe(DEFAULT_NAI_THINKING);
    // 口径归属:latent 那份写的是站点(Anima 系 / Qwen 编码器),NAI 那份写的是官方接口
    expect(DEFAULT_LATENT_SPEC).toContain('Anima');
    expect(DEFAULT_NAI_SPEC).toContain('NovelAI');
  });

  it('latent 的 nl 段是无条件写死的,不靠开关', () => {
    // 计数锁定句与「归属交给 nl」是 latent 单串口径的两条承重规则,必须在文本里直接成立
    expect(DEFAULT_LATENT_SPEC).toContain('No other people or duplicate identities are present');
    expect(DEFAULT_LATENT_SPEC).toContain('归属与配对全部交给 nl');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 联动加词(autoTag/tagRules.ts)的**持久化契约**:两个渠道各一份规则表 + 总开关,都必须在那套
 * **逐字段重建**的 normalize 里有位置——漏接 = 载入即剥、ready 后第一次设置变更写回后永久丢
 * (architecture.md §8;同类事故:connPresets 折叠、latentSpec/latentThinking 两键)。
 *
 * 规则表本身的清洗/匹配语义在 autoTag/tagRules.test.ts,这里只锁「存得住、取得出、两渠道不串」。
 */

const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

/** 动态导入是必须的:settings 是模块级单例,`vi.resetModules()` 后要按本用例的存储重新 hydrate。 */
async function hydrateWithStored(stored: Record<string, unknown>) {
  mocks.context = {
    extensionSettings: { baibai_image: stored },
    saveSettingsDebounced: vi.fn(),
  };
  const mod = await import('@/state/settings');
  await mod.hydrateSettings();
  return mod;
}

describe('联动加词的设置字段', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('NAI 渠道:改过的规则与总开关 hydrate 后原样还在,词表逐条清洗', async () => {
    const { settings } = await hydrateWithStored({
      nai: {
        tagRulesEnabled: false,
        tagRules: [
          {
            id: 'r1',
            name: '脱敏',
            triggers: [' nsfw ', 'NSFW'],
            add: ['<uncensored>'],
            target: 'negative',
            enabled: false,
          },
        ],
      },
    });

    expect(settings.nai.tagRulesEnabled).toBe(false);
    expect(settings.nai.tagRules).toEqual([
      {
        id: 'r1',
        name: '脱敏',
        triggers: ['nsfw'], // trim + 按小写去重(留首现写法)
        add: ['uncensored'], // 剥尖括号:字面量子标签不能从设置里溜进正文
        target: 'negative',
        enabled: false,
      },
    ]);
  });

  it('两渠道各一份,互不串', async () => {
    const { settings } = await hydrateWithStored({
      nai: {
        tagRules: [{ id: 'n1', name: 'NAI 的', triggers: ['a'], add: ['b'], target: 'positive', enabled: true }],
      },
      latent: {
        tagRules: [{ id: 'l1', name: 'Latent 的', triggers: ['c'], add: ['d'], target: 'negative', enabled: true }],
      },
    });

    expect(settings.nai.tagRules.map(rule => rule.id)).toEqual(['n1']);
    expect(settings.latent.tagRules.map(rule => rule.id)).toEqual(['l1']);
  });

  it('老数据/新装:空表 + 总开关默认开(空表本就零行为,故不必先找开关)', async () => {
    const { settings } = await hydrateWithStored({});

    expect(settings.nai.tagRules).toEqual([]);
    expect(settings.nai.tagRulesEnabled).toBe(true);
    expect(settings.latent.tagRules).toEqual([]);
    expect(settings.latent.tagRulesEnabled).toBe(true);
  });

  it('activeTagRules():按**当前出图渠道**取表,ComfyUI/WebUI 空表', async () => {
    const { settings, activeTagRules } = await hydrateWithStored({
      nai: { tagRules: [{ id: 'n1', name: 'NAI 的', triggers: ['a'], add: ['b'], target: 'positive', enabled: true }] },
      latent: { tagRules: [{ id: 'l1', name: 'Latent 的', triggers: ['c'], add: ['d'], target: 'negative', enabled: true }] },
    });

    settings.defaultBackend = 'nai';
    expect(activeTagRules().rules.map(rule => rule.id)).toEqual(['n1']);
    expect(activeTagRules().enabled).toBe(true);

    settings.defaultBackend = 'latent';
    expect(activeTagRules().rules.map(rule => rule.id)).toEqual(['l1']);
    expect(activeTagRules().enabled).toBe(true);

    // 总开关跟着渠道走
    settings.latent.tagRulesEnabled = false;
    expect(activeTagRules().enabled).toBe(false);

    // ComfyUI/WebUI 没有规则表:不注入
    settings.defaultBackend = 'comfyui';
    expect(activeTagRules()).toEqual({ enabled: false, rules: [] });
  });
});

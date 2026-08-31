import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Latent 渠道(站点 NovelAI 兼容面)的设置清洗与 NAI 视图映射:
 * 1. normalizeLatent 钳制到站点原生域:steps 8–16、并发 1–4、scale 0–10;
 * 2. latentAsNai 把渠道设置映射成 NAI 视图:vibes 恒空、undesiredContent=negativePrompt、
 *    画师串等与 NAI 渠道共享的字段照抄 settings.nai;
 * 3. latentDefaults 内置站点固定档尺寸与原生默认参数。
 */

const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

// 动态导入是刻意的:settings 是模块级单例,import 时即读 context;
// vi.resetModules() 后必须重新 import 才能以新 mock 的 context 走一遍 hydrateSettings。
// 静态导入拿到的永远是旧实例,无法逐个用例重置——与其他 settings.*.test.ts 同款。
async function hydrateWithLatent(latent: Record<string, unknown> | null) {
  mocks.context = {
    extensionSettings: latent === null ? {} : { baibai_image: { latent } },
    saveSettingsDebounced: vi.fn(),
  };
  const mod = await import('@/state/settings');
  await mod.hydrateSettings();
  return mod;
}

describe('Latent 渠道设置', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('latentDefaults:内置站点兼容前缀、固定两档尺寸与原生默认参数', async () => {
    const { settings, LATENT_DEFAULT_URL, LATENT_PORTRAIT_SIZE, LATENT_LANDSCAPE_SIZE } =
      await hydrateWithLatent(null);
    expect(settings.latent.url).toBe(LATENT_DEFAULT_URL);
    expect(settings.latent.resolution).toBe(LATENT_PORTRAIT_SIZE);
    expect(settings.latent.portraitSize).toBe(LATENT_PORTRAIT_SIZE);
    expect(settings.latent.landscapeSize).toBe(LATENT_LANDSCAPE_SIZE);
    expect(settings.latent.sampler).toBe('euler');
    expect(settings.latent.noiseSchedule).toBe('normal');
    expect(settings.latent.steps).toBe(12);
    expect(settings.latent.concurrency).toBe(1);
  });

  it('normalizeLatent:steps 钳到 8–16、并发钳到 1–4、scale 钳到 0–10', async () => {
    const { settings } = await hydrateWithLatent({
      steps: 28, // NAI 常用值,超出站点原生域
      concurrency: 8,
      scale: 20,
    });
    expect(settings.latent.steps).toBe(16);
    expect(settings.latent.concurrency).toBe(4);
    expect(settings.latent.scale).toBe(10);
  });

  it('normalizeLatent:低于下限同样钳回(steps 1→8、并发 0→1)', async () => {
    const { settings } = await hydrateWithLatent({ steps: 1, concurrency: 0, scale: -3 });
    expect(settings.latent.steps).toBe(8);
    expect(settings.latent.concurrency).toBe(1);
    expect(settings.latent.scale).toBe(0);
  });

  it('normalizeLatent:非数值字段回落默认,不抛错', async () => {
    const { settings } = await hydrateWithLatent({
      steps: 'many',
      concurrency: null,
      scale: true,
    });
    expect(settings.latent.steps).toBe(12);
    expect(settings.latent.concurrency).toBe(1);
    expect(settings.latent.scale).toBe(5);
  });

  it('latentAsNai:vibes 恒空、undesiredContent=渠道负面、variety/cfgRescale 关闭', async () => {
    const { settings, latentAsNai } = await hydrateWithLatent({
      key: 'latent-key',
      negativePrompt: 'lowres, bad hands',
    });
    settings.nai.undesiredContent = '官方负面基线';
    const view = latentAsNai();
    expect(view.key).toBe('latent-key');
    expect(view.undesiredContent).toBe('lowres, bad hands');
    expect(view.vibes).toEqual([]);
    expect(view.varietyBoost).toBe(false);
    expect(view.cfgRescale).toBe(0);
  });

  it('latentAsNai:渠道级负面留空时undesiredContent 为空串,合并方据此回落官方基线', async () => {
    const { latentAsNai } = await hydrateWithLatent({});
    expect(latentAsNai().undesiredContent).toBe('');
  });

  it('latentAsNai:画师串等 NAI 共享字段从 settings.nai 带过来,渠道自有字段覆盖', async () => {
    const { settings, latentAsNai } = await hydrateWithLatent({
      sampler: 'dpmpp_2m',
      steps: 10,
    });
    settings.nai.artistPresets = [
      { id: 'a1', name: '测试画师串', prompt: 'artist:test', quality: '', negative: '' },
    ];
    settings.nai.activeArtistId = 'a1';
    settings.nai.steps = 28;
    const view = latentAsNai();
    expect(view.activeArtistId).toBe('a1');
    expect(view.artistPresets).toEqual(settings.nai.artistPresets);
    // 渠道自有字段覆盖 NAI 同名值
    expect(view.sampler).toBe('dpmpp_2m');
    expect(view.steps).toBe(10);
  });

  it('activeNaiArtistName:latent 渠道同样盖章(共用画师串库,与 NAI 口径一致)', async () => {
    const { settings, activeNaiArtistName } = await hydrateWithLatent({});
    settings.nai.artistPresets = [
      { id: 'a1', name: '厚涂 <test>', prompt: 'artist:test', quality: '', negative: '' },
    ];
    settings.nai.activeArtistId = 'a1';
    settings.defaultBackend = 'latent';
    // 名字里的尖括号被消毒掉(防伪造 <artist> 子标签),空白折叠
    expect(activeNaiArtistName()).toBe('厚涂 test');
    settings.defaultBackend = 'comfyui';
    expect(activeNaiArtistName()).toBe('');
  });

  it('端到端:站点固定档 920×1536/1536×920 经 multipleOf64 豁免通过参数构建', async () => {
    // 回归锁定:920 不是 64 的倍数,曾经被 NAI 协议校验在本地直接拒绝(latent 一次请求
    // 都发不出去),且旧测试只断言常量值未走参数构建,621 绿灯掩盖了阻断。
    const { buildNaiParameters } = await import('@/backends/nai');
    const { settings, latentAsNai, LATENT_PORTRAIT_SIZE, LATENT_LANDSCAPE_SIZE } =
      await hydrateWithLatent({});
    const view = latentAsNai();
    expect(settings.latent.portraitSize).toBe(LATENT_PORTRAIT_SIZE);

    const portrait = buildNaiParameters(view, { prompt: '1girl', seed: 42 }, { multipleOf64: false });
    expect(portrait.width).toBe(920);
    expect(portrait.height).toBe(1536);

    const landscape = buildNaiParameters(
      view,
      { prompt: '1girl', seed: 42, size: 'landscape' },
      { multipleOf64: false },
    );
    expect(landscape.width).toBe(1536);
    expect(landscape.height).toBe(920);

    // NAI 渠道不豁免:同一视图若走默认校验,非 64 倍数必须仍然被拒
    expect(() =>
      buildNaiParameters(view, { prompt: '1girl', seed: 42 }),
    ).toThrow(/64/);
  });
});

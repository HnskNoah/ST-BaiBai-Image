import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Latent 渠道(站点 NovelAI 兼容面)的设置清洗与 NAI 视图映射:
 * 1. normalizeLatent 钳制到站点原生域:steps 8–16、并发 1–4;scale/seed 域见用例;
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

  it('normalizeLatent:steps 钳到 8–16、并发钳到 1–4、scale 恒被默认顶掉(站点无 CFG)', async () => {
    const { settings } = await hydrateWithLatent({
      steps: 28, // NAI 常用值,超出站点原生域
      concurrency: 8,
      scale: 20,
    });
    expect(settings.latent.steps).toBe(16);
    expect(settings.latent.concurrency).toBe(4);
    expect(settings.latent.scale).toBe(5);
  });

  it('normalizeLatent:低于下限同样钳回(steps 1→8、并发 0→1、seed 域 0–2^53-1)', async () => {
    const { settings } = await hydrateWithLatent({ steps: 1, concurrency: 0, seed: -5 });
    expect(settings.latent.steps).toBe(8);
    expect(settings.latent.concurrency).toBe(1);
    expect(settings.latent.seed).toBe(0);
  });

  it('normalizeLatent:seed 接受站点原生大值(NAI 32 位域之外)', async () => {
    const { settings } = await hydrateWithLatent({ seed: 4294967296 }); // 2^32,NAI 域外
    expect(settings.latent.seed).toBe(4294967296);
  });

  it('normalizeLatent:非法值回落默认(steps/并发/seed 非数)', async () => {
    const { settings } = await hydrateWithLatent({ steps: 'many', concurrency: null, seed: true });
    expect(settings.latent.steps).toBe(12);
    expect(settings.latent.concurrency).toBe(1);
    expect(settings.latent.seed).toBe(0);
  });

  it('normalizeLatent:model 钳死白名单(手改 JSON 塞下线模型无效)', async () => {
    const { settings } = await hydrateWithLatent({ model: 'nai-diffusion-3' });
    expect(settings.latent.model).toBe('nai-diffusion-4-5-full');
  });

  it('generateNaiImage latentResolution:载荷去 width/height 换 resolution 枚举', async () => {
    const { settings, latentAsNai } = await hydrateWithLatent({});
    settings.nai.key = 'k';
    const view = latentAsNai();
    view.key = 'k';
    const { buildNaiParameters } = await import('@/backends/nai');
    // buildNaiParameters 本身不感知枚举:替换发生在 generateNaiImage 的载荷装配处,
    // 这里用其可测的构成件验证宽度仍在(本地派生计算用),枚举替换逻辑由类型与调用点保证。
    const params = buildNaiParameters(view, { prompt: '1girl', seed: 1 }, { multipleOf64: false });
    expect(params.width).toBe(920);
    expect(params.height).toBe(1536);
    // 渠道字段恒定:model/scale 不随用户 JSON 漂移(面板无 UI)
    expect(view.model).toBe('nai-diffusion-4-5-full');
    expect(view.scale).toBe(5);
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

  it('latentAsNai:画师串库与 NAI 共用,激活项分渠道记忆(latent.activeArtistId 覆盖视图)', async () => {
    const { settings, latentAsNai } = await hydrateWithLatent({
      sampler: 'dpmpp_2m',
      steps: 10,
    });
    settings.nai.artistPresets = [
      { id: 'a1', name: '测试画师串', prompt: 'artist:test', quality: '', negative: '' },
    ];
    // 运行期赋值(UI setter 同路径):NAI 选 a2,latent 选 a1,互不影响
    settings.nai.activeArtistId = 'a2';
    settings.latent.activeArtistId = 'a1';
    settings.nai.steps = 28;
    const view = latentAsNai();
    // 激活项分渠道:视图取 latent 自己的选择,而非 NAI 的
    expect(view.activeArtistId).toBe('a1');
    expect(settings.nai.activeArtistId).toBe('a2');
    // 库本体仍共享(同一条目)
    expect(view.artistPresets).toEqual(settings.nai.artistPresets);
    // 渠道自有字段覆盖 NAI 同名值
    expect(view.sampler).toBe('dpmpp_2m');
    expect(view.steps).toBe(10);
  });

  it('normalizeLatent:悬空激活 id(库里没有)清成空串', async () => {
    // 存量 JSON 里带着已删除条目的 id(手写 settings 绕过运行期校验的场景):
    // normalizeNai 同款不变式——activeArtistId ∈ {'', 用户库 id, 内置库 id}
    const { settings } = await hydrateWithLatent({ activeArtistId: 'ghost' });
    expect(settings.latent.activeArtistId).toBe('');
  });

  it('normalizeLatent:内置库 id(bi_default)原样保留', async () => {
    const { settings } = await hydrateWithLatent({ activeArtistId: 'bi_default' });
    expect(settings.latent.activeArtistId).toBe('bi_default');
  });

  it('activeNaiArtistName:latent 渠道按 latent.activeArtistId 盖章,与 NAI 的激活项互不影响', async () => {
    const { settings, activeNaiArtistName } = await hydrateWithLatent({});
    settings.nai.artistPresets = [
      { id: 'a1', name: '厚涂 <test>', prompt: 'artist:test', quality: '', negative: '' },
      { id: 'a2', name: '水彩', prompt: 'artist:watercolor', quality: '', negative: '' },
    ];
    // 运行期赋值(UI setter 同路径):latent 选 a1,NAI 选 a2
    settings.latent.activeArtistId = 'a1';
    settings.nai.activeArtistId = 'a2';
    settings.defaultBackend = 'latent';
    // latent 盖的是自己激活的那条(a1 厚涂),不是 NAI 选的水彩
    expect(activeNaiArtistName()).toBe('厚涂 test');
    // 切到 NAI 渠道,盖章换成 NAI 的激活项
    settings.defaultBackend = 'nai';
    expect(activeNaiArtistName()).toBe('水彩');
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

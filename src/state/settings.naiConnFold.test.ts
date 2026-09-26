import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

/**
 * 旧「连接配置库」(connPresets)→ 上游接入点(endpoints)的一次性折叠。
 *
 * 这个文件守的是**升级不换出口**:折叠前后 effectiveNai() 必须是同一对 url/key,
 * 用户存过的站一条不丢;载体(NaiSettings.connPresets)零消费,只为「装回旧版还能读回库」而存在。
 *
 * 与上游 settings.naiEndpointMigration.test.ts 的分工:那边测渠道级 url/key 这对存量字段
 * 的迁移与本版不变式(官方条保底、悬空回落),这里测**本分支独有的那条**旧存储形态。
 */

const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

const OFFICIAL = 'https://image.novelai.net';
const MIRROR = 'https://mirror.example.com';

/** 用一份 extension_settings 里的原始存储跑一次 hydrate,返回模块与那份存储(看回写)。
 *  动态 import 是必须的:`vi.resetModules()` + 逐例重导是这个模块(模块级 reactive 单例)
 *  的既有测试口径,静态导入拿不到「按本用例的存储重新初始化」的那一份。 */
async function hydrateWithStored(stored: Record<string, unknown> | null) {
  const extensionSettings: Record<string, unknown> = {};
  if (stored) extensionSettings.baibai_image = stored;
  mocks.context = { extensionSettings, saveSettingsDebounced: vi.fn() };
  const mod = await import('@/state/settings');
  await mod.hydrateSettings();
  return { mod, extensionSettings };
}

/** 旧版(连接配置库时代)的一份落盘形态:库两条 + 顶层生效值指向镜像站。 */
function devStored(extra: Record<string, unknown> = {}) {
  return {
    nai: {
      url: MIRROR,
      key: 'mirror-key',
      connPresets: [
        { id: 'conn_official', name: '官方', url: OFFICIAL, key: 'official-key' },
        { id: 'conn_mirror', name: '镜像站', url: MIRROR, key: 'mirror-key' },
      ],
      activeConnId: 'conn_mirror',
      ...extra,
    },
  };
}

function storedNai(extensionSettings: Record<string, unknown>): Record<string, any> {
  return (extensionSettings.baibai_image as { nai: Record<string, any> }).nai;
}

describe('旧连接配置库 → 接入点折叠', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('出口零变化:折叠后 effectiveNai() 与升级前顶层 url/key 逐字相同,条目一条不丢', async () => {
    const { mod } = await hydrateWithStored(devStored());
    const { settings, effectiveNai } = mod;

    // 靶心断言:升级后第一次出图打的是同一个站、用同一把 key
    expect(effectiveNai().url).toBe(MIRROR);
    expect(effectiveNai().key).toBe('mirror-key');
    expect(settings.nai.activeEndpointId).toBe('conn_mirror');

    // 库里的镜像条目原样成条(id/名字/key 全保留——id 保留才能让 activeConnId 直接对位)
    expect(settings.nai.endpoints.find(e => e.id === 'conn_mirror')).toEqual({
      id: 'conn_mirror',
      name: '镜像站',
      url: MIRROR,
      key: 'mirror-key',
    });
    // 库里那条官方地址并进内置官方条(取其 key),且不出现两条同址
    expect(settings.nai.endpoints.find(e => e.id === 'nep_official')).toEqual({
      id: 'nep_official',
      name: 'NovelAI 官方',
      url: OFFICIAL,
      key: 'official-key',
    });
    expect(settings.nai.endpoints.filter(e => e.url === OFFICIAL)).toHaveLength(1);
    expect(settings.nai.endpoints).toHaveLength(2);
  });

  it('「手动填写」的第三方站:合成一条「我的接入点」并选中,官方条补在末尾不抢位', async () => {
    const { mod } = await hydrateWithStored({
      nai: {
        url: MIRROR,
        key: 'mirror-key',
        connPresets: [
          { id: 'conn_a', name: '官方', url: OFFICIAL, key: 'k1' },
          { id: 'conn_b', name: '另一个站', url: 'https://other.example.com', key: 'k2' },
        ],
        // 旧版「手动填写」:生效值只在顶层,不归任何配置
        activeConnId: '',
      },
    });
    const { settings, effectiveNai } = mod;

    expect(effectiveNai().url).toBe(MIRROR);
    expect(effectiveNai().key).toBe('mirror-key');
    expect(settings.nai.activeEndpointId).toBe('nep_legacy');
    expect(settings.nai.endpoints[0]).toMatchObject({ name: '我的接入点', url: MIRROR });
    // 官方条补在末尾:当前生效的那条不会被挤到第二位
    expect(settings.nai.endpoints.at(-1)).toMatchObject({ id: 'nep_official' });
  });

  it('顶层就是官方地址(最常见的一类用户):直接并进官方条,key 取自顶层', async () => {
    const { mod } = await hydrateWithStored({
      nai: { url: OFFICIAL, key: 'official-key', connPresets: [], activeConnId: '' },
    });
    expect(mod.settings.nai.endpoints).toEqual([
      { id: 'nep_official', name: 'NovelAI 官方', url: OFFICIAL, key: 'official-key' },
    ]);
    expect(mod.effectiveNai().key).toBe('official-key');
  });

  it('库里有多条官方地址条目时,官方条的 key 取顶层生效那把(不是库内第一条)', async () => {
    // 形状来源:旧版允许一份库里存两条同址条目(两张月卡 / 复制出来的副本),activeConnId 指向第二条。
    // 顶层才是生效值 ⇒ 取库内第一条会把用户的 key 静默换掉,违背「出口零变化」。
    const { mod } = await hydrateWithStored({
      nai: {
        url: OFFICIAL,
        key: 'key-B',
        connPresets: [
          { id: 'conn_a', name: '官方 A', url: OFFICIAL, key: 'key-A' },
          { id: 'conn_b', name: '官方 B', url: OFFICIAL, key: 'key-B' },
        ],
        activeConnId: 'conn_b',
      },
    });
    expect(mod.settings.nai.endpoints.filter(e => e.id === 'nep_official')).toEqual([
      { id: 'nep_official', name: 'NovelAI 官方', url: OFFICIAL, key: 'key-B' },
    ]);
    expect(mod.effectiveNai()).toMatchObject({ url: OFFICIAL, key: 'key-B' });
  });

  it('已有接入点列表 = 绝不重折:载体里的条目不会被重复塞进来', async () => {
    const { mod } = await hydrateWithStored({
      nai: {
        url: MIRROR,
        key: 'mirror-key',
        endpoints: [{ id: 'ep_1', name: 'A', url: 'https://a.example.com', key: 'ka' }],
        activeEndpointId: 'ep_1',
        // 旧版写回后的形态:新列表 + 陈旧载体并存
        connPresets: [{ id: 'conn_x', name: '旧库条目', url: MIRROR, key: 'mirror-key' }],
        activeConnId: 'conn_x',
      },
    });
    expect(mod.settings.nai.endpoints.map(e => e.id)).toEqual(['ep_1', 'nep_official']);
    expect(mod.effectiveNai().url).toBe('https://a.example.com');
  });

  it('折叠当场落盘 + 留原样备份;此后任一设置变更写回,接入点与载体都还在', async () => {
    const { mod, extensionSettings } = await hydrateWithStored(devStored());

    // ① 不等「第一次设置变更」:hydrate 里就落盘(否则会有「内存已折叠、服务器还是旧形态」的中间态)
    expect(storedNai(extensionSettings).endpoints).toHaveLength(2);
    // ② 迁移前的原样快照,供手工回滚
    const backup = extensionSettings.baibai_image_pre_endpoint_backup as { nai: { connPresets: unknown[] } };
    expect(backup.nai.connPresets).toHaveLength(2);
    // ③ 常规回写路径(deep watch → persist):新形态与回滚载体都写回。
    // 先改一个 **nai 域**的字段并断言它出现在持久化对象里 —— 否则这一步无法区分「回写跑了」
    // 与「看到的是 hydrate 那次立即写的结果」(storedNai 读的是 .nai,ui 域的变化看不到)。
    const nextSteps = mod.settings.nai.steps + 1;
    mod.settings.nai.steps = nextSteps;
    await nextTick();
    expect(storedNai(extensionSettings).steps).toBe(nextSteps);
    expect(storedNai(extensionSettings).endpoints).toHaveLength(2);
    expect(storedNai(extensionSettings).connPresets).toHaveLength(2);
  });

  it('载体零消费:改它/清空它不影响出口,也不动接入点列表', async () => {
    const { mod } = await hydrateWithStored(devStored());
    mod.settings.nai.connPresets = [];
    mod.settings.nai.activeConnId = '';
    await nextTick();

    expect(mod.effectiveNai().url).toBe(MIRROR);
    expect(mod.settings.nai.endpoints).toHaveLength(2);
  });

  it('没有旧库的存储不长出载体键(避免给新装/上游用户写死数据)', async () => {
    const { mod, extensionSettings } = await hydrateWithStored({
      nai: { url: OFFICIAL, key: 'official-key' },
    });
    expect(mod.settings.nai.connPresets).toBeUndefined();

    // 必须真触发一次回写:否则这里只是在读我们刚塞进去的输入对象,断言恒真(测不到任何东西)。
    // 同理要改 **nai 域**的字段(storedNai 只取 .nai),这样才能证明回写确实跑过。
    const nextSteps = mod.settings.nai.steps + 1;
    mod.settings.nai.steps = nextSteps;
    await nextTick();
    expect(storedNai(extensionSettings).steps).toBe(nextSteps);
    expect('connPresets' in storedNai(extensionSettings)).toBe(false);
  });

  it('latent 视图自带自己的出口:端点就是 latent 的地址与 key,不会串到 NAI 接入点', async () => {
    const { mod } = await hydrateWithStored(devStored());
    const view = mod.latentAsNai({
      ...mod.settings.latent,
      url: 'https://latent.example.com/api/novelai',
      key: 'latent-key',
    });
    const endpoint = view.endpoints.find(e => e.id === view.activeEndpointId);
    expect(view.endpoints).toHaveLength(1);
    expect(endpoint).toMatchObject({ url: 'https://latent.example.com/api/novelai', key: 'latent-key' });
  });
});

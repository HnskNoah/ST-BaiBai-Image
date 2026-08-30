import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * NAI 连接配置库(connPresets:接口地址 + API Key 成对保存)的存量迁移与 normalize。
 * 关键点:
 * 1. 老数据没有 connPresets 键 → 按存量 url/key 播种一条「默认配置」并接管,升级前后生效值零变化;
 * 2. 播种判定用「键不存在」而非「数组为空」——键一旦落盘,用户删光的配置不会被再播种;
 * 3. 悬空 activeConnId 清成空串(手动填写),绝不回落第一条(静默换接口地址没法排查)。
 */

const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

async function hydrateWithNai(nai: Record<string, unknown> | null) {
  mocks.context = {
    extensionSettings: nai === null ? {} : { baibai_image: { nai } },
    saveSettingsDebounced: vi.fn(),
  };
  const mod = await import('@/state/settings');
  await mod.hydrateSettings();
  return mod;
}

describe('NAI 连接配置库迁移', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('存量 url/key 播种成一条「默认配置」并接管,生效值零变化', async () => {
    const { settings } = await hydrateWithNai({
      url: 'https://mirror.example.com',
      key: 'nai-old',
    });
    expect(settings.nai.connPresets).toHaveLength(1);
    const [preset] = settings.nai.connPresets;
    expect(preset.name).toBe('默认配置');
    expect(preset.url).toBe('https://mirror.example.com');
    expect(preset.key).toBe('nai-old');
    expect(settings.nai.activeConnId).toBe(preset.id);
    // 顶层生效值原样保留:nai.ts 各请求方只读它们
    expect(settings.nai.url).toBe('https://mirror.example.com');
    expect(settings.nai.key).toBe('nai-old');
  });

  it('键已存在(哪怕空数组)不再播种:用户删光的配置不会被复活', async () => {
    const { settings } = await hydrateWithNai({
      url: 'https://mirror.example.com',
      key: 'nai-old',
      connPresets: [],
    });
    expect(settings.nai.connPresets).toEqual([]);
    expect(settings.nai.activeConnId).toBe('');
  });

  it('已有配置原样保留;悬空 activeConnId 清成空串,不回落第一条', async () => {
    const { settings } = await hydrateWithNai({
      url: 'https://a.example.com',
      key: 'k-a',
      connPresets: [
        { id: 'conn_x', name: '镜像站', url: 'https://b.example.com', key: 'k-b' },
        { url: 'https://c.example.com' }, // 缺 id/name/key:逐项补全
      ],
      activeConnId: 'conn_gone',
    });
    expect(settings.nai.connPresets).toHaveLength(2);
    expect(settings.nai.connPresets[0]).toEqual({
      id: 'conn_x',
      name: '镜像站',
      url: 'https://b.example.com',
      key: 'k-b',
    });
    // 缺失字段逐项回退:名字按序号补、id 重新生成
    expect(settings.nai.connPresets[1].name).toBe('配置 2');
    expect(settings.nai.connPresets[1].id).toMatch(/^conn_/);
    expect(settings.nai.connPresets[1].key).toBe('');
    expect(settings.nai.activeConnId).toBe('');
  });

  it('首装无存量数据:默认值出生即带一条「默认配置」(官方地址)并选中', async () => {
    const { settings } = await hydrateWithNai(null);
    expect(settings.nai.connPresets).toHaveLength(1);
    expect(settings.nai.connPresets[0].name).toBe('默认配置');
    expect(settings.nai.connPresets[0].url).toBe('https://image.novelai.net');
    expect(settings.nai.activeConnId).toBe(settings.nai.connPresets[0].id);
  });

  it('activeNaiConn():空串/悬空返回 null(手动填写),有效 id 返回条目', async () => {
    const { settings, activeNaiConn } = await hydrateWithNai({
      url: 'https://mirror.example.com',
      key: 'k',
    });
    expect(activeNaiConn()).toBe(settings.nai.connPresets[0]);

    settings.nai.activeConnId = '';
    expect(activeNaiConn()).toBeNull();
  });
});

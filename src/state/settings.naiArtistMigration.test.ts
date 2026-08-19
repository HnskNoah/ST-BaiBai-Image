import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * NAI 画师串库的存量与脏数据处理。
 *
 * 与 ComfyUI 工作流库**刻意相反**的三条,是本文件的主要看点:
 * 1. 库允许为空,`naiDefaults` 也不播种任何条目——画师串是可选调味,
 *    凭空塞一条会让人以为自己被套了某种画风;
 * 2. `activeArtistId` 悬空时清成空串,**不**回落第一条。回落等于给用户静默换一套画风,
 *    而下拉显示的正是那一条(看起来就是自己设的),几乎无法排查;
 * 3. 纯加法迁移,没有老字段可折——老配置升级后正向提示词输出必须逐字节不变。
 */

const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

async function hydrateWithNai(nai: Record<string, unknown> | undefined) {
  mocks.context = {
    extensionSettings: { baibai_image: nai === undefined ? {} : { nai } },
    saveSettingsDebounced: vi.fn(),
  };
  const { hydrateSettings, settings } = await import('@/state/settings');
  await hydrateSettings();
  return settings;
}

describe('NAI 画师串库', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('存量配置没有这两个键 → 空库 + 不使用,不抛(升级后出图提示词零变化)', async () => {
    const settings = await hydrateWithNai({ model: 'nai-diffusion-4-5-full', key: 'k' });
    expect(settings.nai.artistPresets).toEqual([]);
    expect(settings.nai.activeArtistId).toBe('');
  });

  it('nai 键整个缺失 → 同样是空库 + 不使用', async () => {
    const settings = await hydrateWithNai(undefined);
    expect(settings.nai.artistPresets).toEqual([]);
    expect(settings.nai.activeArtistId).toBe('');
  });

  it('新格式原样保留,当前项不被动(迁移幂等)', async () => {
    const settings = await hydrateWithNai({
      artistPresets: [
        { id: 'art_a', name: '厚涂', prompt: 'artist:wlop' },
        { id: 'art_b', name: '赛璐璐', prompt: 'artist:as109' },
      ],
      activeArtistId: 'art_b',
    });
    expect(settings.nai.artistPresets.map(a => a.id)).toEqual(['art_a', 'art_b']);
    expect(settings.nai.artistPresets.map(a => a.name)).toEqual(['厚涂', '赛璐璐']);
    expect(settings.nai.activeArtistId).toBe('art_b');
  });

  it('当前项指向已删条目 → 清成空串,**不**回落第一条', async () => {
    // 与 normalizeComfyUI 的「悬空回落 workflows[0]」刻意不同:那里工作流是必需品,
    // 这里回落会给用户静默套上一套没选过的画风,每张图都变样却查不出原因。
    const settings = await hydrateWithNai({
      artistPresets: [{ id: 'art_a', name: 'A', prompt: 'artist:a' }],
      activeArtistId: 'art_gone',
    });
    expect(settings.nai.activeArtistId).toBe('');
    // 库本身不受影响,条目还在
    expect(settings.nai.artistPresets).toHaveLength(1);
  });

  it('库为空数组但 id 非空 → id 清空,库保持空(不补条目,与工作流库的恒非空相反)', async () => {
    const settings = await hydrateWithNai({ artistPresets: [], activeArtistId: 'art_x' });
    expect(settings.nai.artistPresets).toEqual([]);
    expect(settings.nai.activeArtistId).toBe('');
  });

  it('activeArtistId 不是字符串 → 清成空串', async () => {
    const settings = await hydrateWithNai({
      artistPresets: [{ id: 'art_a', name: 'A', prompt: 'artist:a' }],
      activeArtistId: 42,
    });
    expect(settings.nai.activeArtistId).toBe('');
  });

  it('条目缺字段/含脏数据 → 逐项补齐,不整条丢弃', async () => {
    const settings = await hydrateWithNai({
      artistPresets: [{ name: 'no id' }, null, { id: 'art_c', prompt: 42 }],
      activeArtistId: 'art_c',
    });

    expect(settings.nai.artistPresets).toHaveLength(3);
    const [first, second, third] = settings.nai.artistPresets;
    // 缺 id 的补一个,名字保留
    expect(first.id).toBeTruthy();
    expect(first.name).toBe('no id');
    // null 条目也补齐成可用的空槽位,名字按序号给
    expect(second.id).toBeTruthy();
    expect(second.name).toBe('画师串 2');
    expect(second.prompt).toBe('');
    // 非字符串 prompt 归空串;有效 id 仍被 activeArtistId 认到
    expect(third.prompt).toBe('');
    expect(settings.nai.activeArtistId).toBe('art_c');
  });

  it('prompt 是空串的条目照样保留(那是用户面对的空槽位,不是垃圾数据)', async () => {
    const settings = await hydrateWithNai({
      artistPresets: [{ id: 'art_a', name: '待填', prompt: '' }],
      activeArtistId: 'art_a',
    });
    expect(settings.nai.artistPresets).toHaveLength(1);
    expect(settings.nai.activeArtistId).toBe('art_a');
  });

  it('activeNaiArtist 取当前项;未选 / 悬空时返回 null', async () => {
    mocks.context = {
      extensionSettings: {
        baibai_image: {
          nai: {
            artistPresets: [
              { id: 'art_a', name: 'A', prompt: 'artist:a' },
              { id: 'art_b', name: 'B', prompt: 'artist:b' },
            ],
            activeArtistId: 'art_b',
          },
        },
      },
      saveSettingsDebounced: vi.fn(),
    };
    const { hydrateSettings, activeNaiArtist, settings } = await import('@/state/settings');
    await hydrateSettings();

    expect(activeNaiArtist()?.name).toBe('B');
    expect(activeNaiArtist()?.prompt).toBe('artist:b');

    // 切到「不使用」
    settings.nai.activeArtistId = '';
    expect(activeNaiArtist()).toBeNull();

    // 悬空(UI 运行中把库改坏这种时序)也返回 null,而不是兜底成第一条
    settings.nai.activeArtistId = 'art_gone';
    expect(activeNaiArtist()).toBeNull();
  });

  it('newNaiArtist 连续调用 id 不重复(同一毫秒内也不撞)', async () => {
    const { newNaiArtist } = await import('@/state/settings');
    const ids = [newNaiArtist(), newNaiArtist(), newNaiArtist()].map(a => a.id);
    expect(new Set(ids).size).toBe(3);
    // art_ 前缀不与 wf_ / ch_ 的 id 空间相撞
    expect(ids.every(id => id.startsWith('art_'))).toBe(true);
  });
});

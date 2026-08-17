import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
  saveVibeFiles: vi.fn(),
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

vi.mock('@/backends/vibeStore', () => ({
  saveVibeFiles: mocks.saveVibeFiles,
  vibeFingerprint: (encodings: Record<string, { encoding: string }>) =>
    Object.keys(encodings)
      .sort()
      .map(key => `${key}:${encodings[key].encoding.slice(0, 64)}`)
      .join('|'),
  vibeMetaFromData: (
    id: string,
    name: string,
    dataPath: string,
    thumbnailPath: string,
    data: { image: string; encodings: Record<string, { encoding: string }> },
    strength: number,
    enabled: boolean,
  ) => ({
    id,
    name,
    dataPath,
    thumbnailPath,
    modelKeys: Object.keys(data.encodings),
    hasImage: !!data.image,
    fingerprint: Object.keys(data.encodings)
      .sort()
      .map(key => `${key}:${data.encodings[key].encoding.slice(0, 64)}`)
      .join('|'),
    strength,
    enabled,
  }),
}));

describe('旧版 Vibe 设置迁移', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.saveVibeFiles.mockReset();
    vi.stubGlobal('toastr', {
      info: vi.fn(),
      success: vi.fn(),
      error: vi.fn(),
    });
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });
  });

  it('把大字段上传后只留下文件路径和小型索引', async () => {
    const saveSettingsDebounced = vi.fn();
    const legacy = {
      id: 'legacy-v1',
      name: '旧 Vibe',
      image: 'A'.repeat(1024),
      thumbnail: 'data:image/jpeg;base64,dGh1bWI=',
      encodings: { 'v4-5full': { encoding: 'B'.repeat(512), infoExtracted: 1 } },
      strength: 0.7,
      enabled: true,
    };
    mocks.context = {
      extensionSettings: {
        baibai_image: {
          nai: { vibes: [legacy] },
        },
      },
      saveSettingsDebounced,
    };
    mocks.saveVibeFiles.mockResolvedValue({
      dataPath: '/user/files/bbi-vibe-legacy-v1.json',
      thumbnailPath: '/user/files/bbi-vibe-thumb-legacy-v1.jpg',
    });

    const { hydrateSettings, settings } = await import('@/state/settings');
    await hydrateSettings();

    expect(mocks.saveVibeFiles).toHaveBeenCalledOnce();
    expect(settings.nai.vibes[0]).toMatchObject({
      id: 'legacy-v1',
      dataPath: '/user/files/bbi-vibe-legacy-v1.json',
      thumbnailPath: '/user/files/bbi-vibe-thumb-legacy-v1.jpg',
      modelKeys: ['v4-5full'],
      hasImage: true,
      strength: 0.7,
      enabled: true,
    });
    const persisted = mocks.context.extensionSettings.baibai_image.nai.vibes[0];
    expect(persisted).not.toHaveProperty('image');
    expect(persisted).not.toHaveProperty('thumbnail');
    expect(persisted).not.toHaveProperty('encodings');
    expect(saveSettingsDebounced).toHaveBeenCalled();
  });

  it('每条落盘后立即释放该条大字段', async () => {
    const vibes = [
      { id: 'legacy-1', image: 'A'.repeat(1024), thumbnail: '', encodings: {} },
      { id: 'legacy-2', image: 'B'.repeat(1024), thumbnail: '', encodings: {} },
    ];
    mocks.context = {
      extensionSettings: { baibai_image: { nai: { vibes } } },
      saveSettingsDebounced: vi.fn(),
    };
    mocks.saveVibeFiles
      .mockResolvedValueOnce({ dataPath: '/user/files/1.json', thumbnailPath: '' })
      .mockImplementationOnce(async () => {
        expect(vibes[0]).not.toHaveProperty('image');
        expect(vibes[1]).toHaveProperty('image');
        return { dataPath: '/user/files/2.json', thumbnailPath: '' };
      });

    const { hydrateSettings } = await import('@/state/settings');
    await hydrateSettings();

    expect(vibes[0]).not.toHaveProperty('image');
    expect(vibes[1]).not.toHaveProperty('image');
  });

  it('单条保存失败时保留原数据且不进入正常设置回写', async () => {
    const saveSettingsDebounced = vi.fn();
    const legacy = {
      id: 'legacy-failed',
      image: 'A'.repeat(1024),
      thumbnail: '',
      encodings: {},
    };
    mocks.context = {
      extensionSettings: { baibai_image: { nai: { vibes: [legacy] } } },
      saveSettingsDebounced,
    };
    mocks.saveVibeFiles.mockRejectedValue(new Error('server 与 IndexedDB 都失败'));

    const { hydrateSettings } = await import('@/state/settings');
    await expect(hydrateSettings()).rejects.toThrow('server 与 IndexedDB 都失败');

    expect(mocks.context.extensionSettings.baibai_image.nai.vibes[0]).toBe(legacy);
    expect(legacy).toHaveProperty('image');
    expect(saveSettingsDebounced).not.toHaveBeenCalled();
  });

  it('部分失败时保存已释放条目并保留失败条目', async () => {
    const saveSettingsDebounced = vi.fn();
    const vibes = [
      { id: 'legacy-ok', image: 'A'.repeat(1024), thumbnail: '', encodings: {} },
      { id: 'legacy-failed', image: 'B'.repeat(1024), thumbnail: '', encodings: {} },
    ];
    mocks.context = {
      extensionSettings: { baibai_image: { nai: { vibes } } },
      saveSettingsDebounced,
    };
    mocks.saveVibeFiles
      .mockResolvedValueOnce({ dataPath: '/user/files/ok.json', thumbnailPath: '' })
      .mockRejectedValueOnce(new Error('第二条失败'));

    const { hydrateSettings } = await import('@/state/settings');
    await expect(hydrateSettings()).rejects.toThrow('第二条失败');

    expect(vibes[0]).not.toHaveProperty('image');
    expect(vibes[1]).toHaveProperty('image');
    expect(saveSettingsDebounced).toHaveBeenCalledOnce();
  });
});

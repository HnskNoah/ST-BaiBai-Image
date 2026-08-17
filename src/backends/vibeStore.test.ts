import { beforeEach, describe, expect, it, vi } from 'vitest';

const fileStore = vi.hoisted(() => ({
  upload: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@/floor/upload', () => ({
  uploadBase64File: fileStore.upload,
  deleteUploadedFile: fileStore.remove,
}));

import {
  deleteVibeData,
  loadVibeData,
  saveVibeFiles,
  vibeMetaFromData,
} from '@/backends/vibeStore';
import type { NaiVibeData } from '@/state/settings';

const data: NaiVibeData = {
  image: 'aW1hZ2U=',
  thumbnail: 'data:image/jpeg;base64,dGh1bWI=',
  encodings: { 'v4-5full': { encoding: 'ZW5jb2Rpbmc=', infoExtracted: 1 } },
};

describe('vibeStore', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    fileStore.upload.mockReset();
    fileStore.remove.mockReset();
  });

  it('设置索引不包含原图和编码正文', () => {
    const meta = vibeMetaFromData(
      'v1',
      '测试',
      '/user/files/bbi-vibe-v1.json',
      '/user/files/bbi-vibe-thumb-v1.jpg',
      data,
      0.6,
      true,
    );
    expect(meta).toMatchObject({
      id: 'v1',
      dataPath: '/user/files/bbi-vibe-v1.json',
      thumbnailPath: '/user/files/bbi-vibe-thumb-v1.jpg',
      modelKeys: ['v4-5full'],
      hasImage: true,
    });
    expect(meta).not.toHaveProperty('image');
    expect(meta).not.toHaveProperty('encodings');
    expect(meta).not.toHaveProperty('thumbnail');
  });

  it('正文和缩略图使用稳定文件名分别上传', async () => {
    fileStore.upload
      .mockResolvedValueOnce('/user/files/bbi-vibe-v1.json')
      .mockResolvedValueOnce('/user/files/bbi-vibe-thumb-v1.jpg');

    await expect(saveVibeFiles(data, null, 'v1')).resolves.toEqual({
      dataPath: '/user/files/bbi-vibe-v1.json',
      thumbnailPath: '/user/files/bbi-vibe-thumb-v1.jpg',
    });
    expect(fileStore.upload).toHaveBeenNthCalledWith(1, 'bbi-vibe-v1.json', expect.any(String));
    expect(fileStore.upload).toHaveBeenNthCalledWith(2, 'bbi-vibe-thumb-v1.jpg', 'dGh1bWI=');
  });

  it('按路径读取正文并删除两份文件', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(data), { status: 200 })));
    const vibe = vibeMetaFromData(
      'v1',
      '测试',
      '/user/files/bbi-vibe-v1.json',
      '/user/files/bbi-vibe-thumb-v1.jpg',
      data,
      0.6,
      true,
    );
    await expect(loadVibeData(vibe)).resolves.toEqual(data);

    fileStore.remove.mockResolvedValue(true);
    await deleteVibeData(vibe);
    expect(fileStore.remove).toHaveBeenNthCalledWith(1, vibe.dataPath);
    expect(fileStore.remove).toHaveBeenNthCalledWith(2, vibe.thumbnailPath);
  });
});

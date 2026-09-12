import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchLatentCaps,
  latentOrigin,
  readLatentCaps,
  testLatentConnection,
  writeLatentCaps,
} from '@/backends/latentCaps';

/**
 * Latent 参数域动态同步(backends/latentCaps.ts):
 * 1. openapi 解析——从源站 /openapi.json 的 GenerationRequest 抽 sampler/scheduler/resolution 枚举;
 * 2. localStorage 快照按 origin 分键读写;
 * 3. testLatentConnection——订阅探测(404=预期)+ 参数域同步并入消息,Key 未验证要如实说。
 *
 * vitest 默认 node 环境无 localStorage:模块内的守卫让读写静默降级,
 * 快照相关用例自行 stub 一个假 localStorage。
 */

const COMPAT_URL = 'https://latent.example.com/api/novelai';

/** 按站点真实结构裁一份最小 openapi(GenerationRequest 三组枚举)。 */
function openapiFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    components: {
      schemas: {
        GenerationRequest: {
          type: 'object',
          properties: {
            prompt: { type: 'string' },
            sampler: { type: 'string', enum: ['euler', 'res_multistep', 'er_sde'] },
            scheduler: {
              type: 'string',
              enum: ['sgm_uniform', 'beta', 'beta57', 'linear_quadratic'],
            },
            resolution: { type: 'string', enum: ['square', 'portrait', 'landscape'] },
            ...overrides,
          },
        },
      },
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubLocalStorage(): Record<string, string> {
  const store: Record<string, string> = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
  });
  return store;
}

describe('latentOrigin', () => {
  it('从兼容面地址(带路径)推导源站 origin', () => {
    expect(latentOrigin(COMPAT_URL)).toBe('https://latent.example.com');
    expect(latentOrigin('https://latent.example.com')).toBe('https://latent.example.com');
    expect(latentOrigin(' https://latent.example.com/api/novelai/ ')).toBe(
      'https://latent.example.com',
    );
  });

  it('空地址/非法地址抛 NaiError', () => {
    expect(() => latentOrigin('')).toThrow('请先填写接口地址');
    expect(() => latentOrigin('不是地址')).toThrow('接口地址无法解析');
  });
});

describe('fetchLatentCaps', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('解析 GenerationRequest 三组枚举', async () => {
    const spec = openapiFixture();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        expect(url).toBe('https://latent.example.com/openapi.json');
        return jsonResponse(spec);
      }),
    );
    const caps = await fetchLatentCaps(COMPAT_URL);
    expect(caps.samplers).toEqual(['euler', 'res_multistep', 'er_sde']);
    expect(caps.schedulers).toEqual(['sgm_uniform', 'beta', 'beta57', 'linear_quadratic']);
    expect(caps.resolutions).toEqual(['square', 'portrait', 'landscape']);
    expect(caps.fetchedAt).toBeGreaterThan(0);
  });

  it('HTTP 非 2xx 报状态码', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 500)));
    await expect(fetchLatentCaps(COMPAT_URL)).rejects.toThrow('openapi.json 返回 500');
  });

  it('非 JSON 响应包装成带原因的 NaiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })));
    await expect(fetchLatentCaps(COMPAT_URL)).rejects.toThrow('拉取参数域失败');
  });

  it('结构缺枚举(站点改版)报结构错误,带字段名', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ components: { schemas: {} } })));
    await expect(fetchLatentCaps(COMPAT_URL)).rejects.toThrow(
      /GenerationRequest 的 sampler\/scheduler\/resolution 枚举/,
    );
  });
});

describe('快照读写', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('按 origin 分键往返,互不串站', () => {
    const store = stubLocalStorage();
    const capsA = {
      samplers: ['euler'],
      schedulers: ['sgm_uniform'],
      resolutions: ['portrait'],
      fetchedAt: 1,
    };
    const capsB = {
      samplers: ['res_multistep'],
      schedulers: ['beta'],
      resolutions: ['landscape'],
      fetchedAt: 2,
    };
    writeLatentCaps('https://a.example.com/api/novelai', capsA);
    writeLatentCaps('https://b.example.com/api/novelai', capsB);
    expect(readLatentCaps('https://a.example.com/api/novelai')).toEqual(capsA);
    expect(readLatentCaps('https://b.example.com/api/novelai')).toEqual(capsB);
    expect(Object.keys(JSON.parse(store['latent.caps.v1']))).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });

  it('无缓存/地址非法/localStorage 不可用一律回落 null,不抛', () => {
    stubLocalStorage();
    expect(readLatentCaps('https://none.example.com/api/novelai')).toBeNull();
    expect(readLatentCaps('')).toBeNull();
    vi.unstubAllGlobals(); // 拔掉 localStorage:node 环境下引用即 ReferenceError,守卫须吃掉
    expect(readLatentCaps(COMPAT_URL)).toBeNull();
  });
});

describe('testLatentConnection', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    stubLocalStorage();
  });

  it('Key 为空直接抛', async () => {
    await expect(testLatentConnection({ url: COMPAT_URL, key: ' ' })).rejects.toThrow(
      '请先填写 API Key',
    );
  });

  it('订阅 404(预期)+ spec 可解析 → 地址可达 + 参数域已同步并写缓存', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        if (String(url).endsWith('/user/subscription')) {
          return new Response('not found', { status: 404 });
        }
        return jsonResponse(openapiFixture());
      }),
    );
    const result = await testLatentConnection({ url: COMPAT_URL, key: 'lat_sk_k' });
    expect(result.message).toContain('地址可达');
    expect(result.message).toContain('参数域已同步:采样器 3 个 / 噪声表 4 个');
    expect(result.message).toContain('Key 未验证');
    const cached = readLatentCaps(COMPAT_URL);
    expect(cached?.samplers).toEqual(['euler', 'res_multistep', 'er_sde']);
  });

  it('订阅 200 → 顺带报 tier,Key 在这一步就算验过了', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        if (String(url).endsWith('/user/subscription')) {
          return jsonResponse({ subscription: { tier: 3, active: true } });
        }
        return jsonResponse(openapiFixture());
      }),
    );
    const result = await testLatentConnection({ url: COMPAT_URL, key: 'lat_sk_k' });
    expect(result.message).toContain('连接正常:Opus');
    expect(result.message).toContain('参数域已同步');
    expect(result.message).not.toContain('Key 未验证');
  });

  it('spec 拉取失败降级不失败:地址可达 + 同步失败(原因) + 继续内置', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        if (String(url).endsWith('/user/subscription')) {
          return new Response('not found', { status: 404 });
        }
        return new Response('gateway timeout', { status: 504 });
      }),
    );
    const result = await testLatentConnection({ url: COMPAT_URL, key: 'lat_sk_k' });
    expect(result.message).toContain('地址可达');
    expect(result.message).toContain('参数域同步失败');
    expect(result.message).toContain('openapi.json 返回 504');
    expect(result.message).toContain('继续用内置参数域');
  });

  it('订阅端点网络错误 → 地址不可达抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    await expect(testLatentConnection({ url: COMPAT_URL, key: 'lat_sk_k' })).rejects.toThrow(
      '地址不可达',
    );
  });

  it('订阅端点 5xx → 报站点错误原文(naiHttpError 语义)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ message: 'bad gateway' }), { status: 502 }),
      ),
    );
    await expect(testLatentConnection({ url: COMPAT_URL, key: 'lat_sk_k' })).rejects.toThrow(
      /连接 Latent 失败 \(502\)/,
    );
  });
});

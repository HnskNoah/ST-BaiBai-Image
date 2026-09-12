import { NaiError, naiEndpoint, naiHttpError } from './nai';
import type { NaiSettings } from '@/state/settings';

/**
 * Latent 站点参数域的动态同步(backends/latentCaps.ts)。
 *
 * 【为什么存在】站点换了底层模型后 sampler/scheduler 等枚举跟着变了,而渠道里写死的
 * 内置枚举只能随插件版本更新——枚举一变,旧下拉值发出去就是 400。站点把原生气图请求
 * 的完整定义公开在源站根路径的 /openapi.json(无需鉴权、CORS `*`,浏览器可直接拉取),
 * 它就是参数域的权威数据源:解析 GenerationRequest 的 enum 即得站点当前接受的合法值。
 *
 * 【拉取时机——刻意只有两个手动入口】「同步参数域」按钮、点「测试连接」时顺手同步。
 * 打开面板/插件启动/生图路径一律不发:面板是高频操作,出图链路不允许新增网络请求。
 * 枚举真变了导致生图 400 时,站点报错原文会透传到卡片错误信息,用户来面板点同步即可。
 *
 * 【缓存】localStorage `latent.caps.v1`,按源站 origin 分键(容忍用户改接口地址指向
 * 别的兼容站),存 {samplers, schedulers, resolutions, fetchedAt} 快照。缓存只是
 * 「上次手动同步的快照」,读取失败/不可用一律回落内置枚举,永不阻塞任何流程。
 */

const CAPS_STORE_KEY = 'latent.caps.v1';

export interface LatentCaps {
  /** 站点当前接受的采样器枚举(GenerationRequest.sampler.enum) */
  samplers: string[];
  /** 站点当前接受的调度器/噪声表枚举(GenerationRequest.scheduler.enum) */
  schedulers: string[];
  /** 站点尺寸档枚举(GenerationRequest.resolution.enum;square 档本轮未接入尺寸决策) */
  resolutions: string[];
  /** 快照时间(epoch ms) */
  fetchedAt: number;
}

/** 从兼容面接口地址(如 https://x.y/api/novelai)推导源站 origin。空/非法地址抛错。 */
export function latentOrigin(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) throw new NaiError('请先填写接口地址');
  try {
    return new URL(trimmed).origin;
  } catch {
    throw new NaiError(`接口地址无法解析:${trimmed}`);
  }
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(item => typeof item === 'string');
}

/**
 * 拉取并解析站点参数域。网络/HTTP/结构三类失败都以 NaiError 抛出,
 * 消息带原因,由调用方决定上报(按钮 toastr)还是降级(测试连接并入消息)。
 */
export async function fetchLatentCaps(url: string, signal?: AbortSignal): Promise<LatentCaps> {
  const origin = latentOrigin(url);
  let spec: unknown;
  try {
    const resp = await fetch(`${origin}/openapi.json`, { signal });
    if (!resp.ok) throw new NaiError(`openapi.json 返回 ${resp.status}`);
    spec = await resp.json();
  } catch (error) {
    if (error instanceof NaiError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new NaiError(`拉取参数域失败:${error instanceof Error ? error.message : String(error)}`);
  }
  const props = (spec as { components?: { schemas?: Record<string, { properties?: Record<string, { enum?: unknown }> }> } })
    ?.components?.schemas?.GenerationRequest?.properties;
  const samplers = props?.sampler?.enum;
  const schedulers = props?.scheduler?.enum;
  const resolutions = props?.resolution?.enum;
  if (!isStringArray(samplers) || !isStringArray(schedulers) || !isStringArray(resolutions)) {
    throw new NaiError('openapi 里找不到 GenerationRequest 的 sampler/scheduler/resolution 枚举(站点结构变了?)');
  }
  return { samplers, schedulers, resolutions, fetchedAt: Date.now() };
}

/* ============ localStorage 快照(node 测试环境无 localStorage,一律静默降级) ============ */

/** 快照形状校验:条目可能被手改/旧版结构/写坏,非法一律弃用——
 *  normalizeLatent 会直接消费这里的字段(.filter),坏形状进启动路径就是炸插件。 */
function isValidCaps(v: unknown): v is LatentCaps {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const c = v as Partial<LatentCaps>;
  return (
    isStringArray(c.samplers) &&
    c.samplers.length > 0 &&
    isStringArray(c.schedulers) &&
    c.schedulers.length > 0 &&
    isStringArray(c.resolutions) &&
    typeof c.fetchedAt === 'number' &&
    Number.isFinite(c.fetchedAt)
  );
}

function readStore(): Record<string, LatentCaps> {
  let raw: unknown;
  try {
    const text = localStorage.getItem(CAPS_STORE_KEY);
    raw = text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const cleaned: Record<string, LatentCaps> = {};
  let dropped = false;
  for (const [origin, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (isValidCaps(entry)) cleaned[origin] = entry;
    else dropped = true;
  }
  // 坏条目顺手清掉:避免每次读取都重复踩一遍
  if (dropped) writeStore(cleaned);
  return cleaned;
}

function writeStore(store: Record<string, LatentCaps>): void {
  try {
    localStorage.setItem(CAPS_STORE_KEY, JSON.stringify(store));
  } catch {
    /* localStorage 不可用(隐私模式/配额)时静默:缓存只是加速,不是数据 */
  }
}

/** 读某源站的参数域快照;无缓存/localStorage 不可用返回 null(调用方回落内置枚举)。 */
export function readLatentCaps(url: string): LatentCaps | null {
  let origin: string;
  try {
    origin = latentOrigin(url);
  } catch {
    return null;
  }
  return readStore()[origin] ?? null;
}

export function writeLatentCaps(url: string, caps: LatentCaps): void {
  let origin: string;
  try {
    origin = latentOrigin(url);
  } catch {
    return;
  }
  const store = readStore();
  store[origin] = caps;
  writeStore(store);
}

/* ============ 测试连接 ============ */

const TIER_NAMES = ['Free', 'Tablet', 'Scroll', 'Opus'];

/**
 * Latent 渠道的测试连接。与 NAI 渠道的 testNaiConnection 分开:站点对 NAI 官方的
 * user/subscription 是 404(兼容面没实现),Key 在这一步从来验不了——如实报告。
 * ①订阅探测:2xx 解析 tier(站点哪天实现了顺带验 Key);404=预期,继续;其余状态抛错。
 * ②参数域同步:成功写缓存并并入消息;失败降级,不失败整个测试。
 */
export async function testLatentConnection(
  nai: Pick<NaiSettings, 'url' | 'key'>,
  signal?: AbortSignal,
): Promise<{ message: string }> {
  if (!nai.key.trim()) throw new NaiError('请先填写 API Key');
  let prefix: string;
  // 订阅查询 2xx = Key 已验;404(兼容面没实现)= Key 没验,后续消息要如实声明
  let keyVerified = false;
  try {
    const resp = await fetch(naiEndpoint(nai.url, 'user/subscription'), {
      headers: { Authorization: `Bearer ${nai.key.trim()}` },
      signal,
    });
    if (resp.ok) {
      const data = (await resp.json().catch(() => null)) as {
        tier?: number;
        active?: boolean;
        subscription?: { tier?: number; active?: boolean; expiresAt?: number };
      } | null;
      const tier = data?.subscription?.tier ?? data?.tier;
      const active = data?.subscription?.active ?? data?.active;
      const tierName = TIER_NAMES[Number(tier)] ?? `Tier ${tier}`;
      prefix = `连接正常:${tierName}${active === false ? '(订阅未激活)' : ''};`;
      keyVerified = true;
    } else if (resp.status === 404) {
      // 预期:兼容面没实现订阅查询。404 本身证明地址可达
      prefix = '地址可达;';
    } else {
      throw await naiHttpError(resp, '连接 Latent 失败');
    }
  } catch (error) {
    if (error instanceof NaiError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new NaiError(`地址不可达:${error instanceof Error ? error.message : String(error)}`);
  }
  const disclaimer = keyVerified ? '' : '(Key 未验证,以实际生图为准)';
  try {
    const caps = await fetchLatentCaps(nai.url, signal);
    writeLatentCaps(nai.url, caps);
    return {
      message: `${prefix}参数域已同步:采样器 ${caps.samplers.length} 个 / 噪声表 ${caps.schedulers.length} 个${disclaimer}`,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    const reason = error instanceof NaiError ? error.message : String(error);
    return { message: `${prefix}参数域同步失败(${reason}),继续用内置参数域${disclaimer}` };
  }
}

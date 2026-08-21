import { unzipSync } from 'fflate';
import { randomUuid } from '@/randomUuid';

import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import type { ComfyImageResult } from '@/backends/comfyui';
import { parseSize, pickSize, type Orientation } from '@/backends/size';
import { clampVibeStrength, loadVibeData } from '@/backends/vibeStore';
import type { NaiSettings, NaiVibe, NaiVibeData, NaiVibeEncodings } from '@/state/settings';

/**
 * NovelAI 生图后端(浏览器直连,协议与官方 image.novelai.net 一致)。
 * url 可指向任意兼容站:官方/镜像/第三方转发,端点自动补 /ai 前缀。
 *
 * 参考 st-chatu8 的实现口径:
 * - 生图 POST {base}/ai/generate-image,body {input, model, action:'generate', parameters}。
 * - 响应是 zip(stream: 'msgpack'),解出第一张图。
 * - NAI3 的 vibe 直接发参考原图;NAI4/4.5 必须先经 /ai/encode-vibe 编码,
 *   生成时以 reference_image_multiple_cached(uuid + 编码数据) 形式叠加。
 * - .naiv4vibe 文件格式与官方互通(encodings 按模型 key 分组)。
 */

export class NaiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'NaiError';
  }
}

/* ============ 常量表(与 st-chatu8 / NAI 官方前端同口径) ============ */

export const NAI_SAMPLERS: { value: string; label: string }[] = [
  { value: 'k_euler', label: 'Euler(推荐)' },
  { value: 'k_euler_ancestral', label: 'Euler Ancestral' },
  { value: 'k_dpmpp_2s_ancestral', label: 'DPM++ 2S Ancestral' },
  { value: 'k_dpmpp_2m', label: 'DPM++ 2M' },
  { value: 'k_dpmpp_2m_sde', label: 'DPM++ 2M SDE' },
  { value: 'k_dpmpp_sde', label: 'DPM++ SDE' },
  { value: 'ddim_v3', label: 'DDIM V3' },
];

export const NAI_NOISE_SCHEDULES: { value: string; label: string }[] = [
  { value: 'karras', label: 'Karras(推荐)' },
  { value: 'native', label: 'Native' },
  { value: 'exponential', label: 'Exponential' },
  { value: 'polyexponential', label: 'Polyexponential' },
];

/** 各模型官方质量词，拼到正向提示词末尾;用户在面板改过则用其覆盖值。 */
const QUALITY_TAGS: Record<string, string> = {
  'nai-diffusion-5-full': 'very aesthetic, masterpiece, no text',
  'nai-diffusion-5-curated': 'very aesthetic, masterpiece, no text',
  'nai-diffusion-4-5-full': 'location, very aesthetic, masterpiece, no text',
  'nai-diffusion-4-5-curated': 'location, masterpiece, no text, -0.8::feet::, rating:general',
  'nai-diffusion-4-full': 'no text, best quality, very aesthetic, absurdres',
  'nai-diffusion-4-curated-preview': 'rating:general, best quality, very aesthetic, absurdres',
  'nai-diffusion-3': 'best quality, amazing quality, very aesthetic, absurdres',
};

/** 各模型官方 Heavy 负面词，作为无需用户选择的通用默认;用户改过则用其覆盖值。 */
const DEFAULT_UNDESIRED_CONTENT: Record<string, string> = {
  'nai-diffusion-5-full':
    'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page',
  'nai-diffusion-5-curated':
    'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page',
  'nai-diffusion-3':
    'lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract]',
  'nai-diffusion-4-full':
    'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, too many watermarks, white blank page, blank page',
  'nai-diffusion-4-curated-preview':
    'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, logo, dated, signature, multiple views, gigantic breasts, white blank page, blank page',
  'nai-diffusion-4-5-curated':
    'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, negative space, blank page',
  'nai-diffusion-4-5-full':
    'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page',
};

/**
 * 某模型的官方质量词 / 官方 Heavy 负面词。面板拿它做「未自定义」时的显示内容
 * 与「恢复默认」的目标,故必须导出:否则用户看不到实际生效的词(改动前的老问题)。
 */
export function naiDefaultQualityTags(model: string): string {
  return QUALITY_TAGS[model] ?? '';
}

export function naiDefaultUndesired(model: string): string {
  return DEFAULT_UNDESIRED_CONTENT[model] ?? '';
}

/** variety boost 的 magic 常数(st-chatu8 同口径):按像素量相对参考分辨率缩放。 */
const REFERENCE_PIXEL_COUNT = 1011712;
const SIGMA_MAGIC_NUMBER = 19;
const SIGMA_MAGIC_NUMBER_V4_5 = 58;

export function isNai5(model: string): boolean {
  return model.includes('nai-diffusion-5');
}

export function naiSupportsVibes(model: string): boolean {
  return isNai3(model) || isNai4Family(model) || isNai5(model);
}

const NAI_V5_SAMPLERS = new Set([
  'k_euler_ancestral',
  'k_euler',
  'k_dpmpp_2s_ancestral',
  'k_dpmpp_2m_sde',
  'k_dpmpp_2m',
  'k_dpmpp_sde',
]);

export function naiSamplers(model: string): { value: string; label: string }[] {
  return isNai5(model) ? NAI_SAMPLERS.filter(sampler => NAI_V5_SAMPLERS.has(sampler.value)) : NAI_SAMPLERS;
}

export function isNai45(model: string): boolean {
  return model.includes('nai-diffusion-4-5');
}

export function isNai4Family(model: string): boolean {
  return model.includes('nai-diffusion-4');
}

function isNai3(model: string): boolean {
  return model === 'nai-diffusion-3';
}

/** skip_cfg_above_sigma:开 variety boost 时按尺寸与模型算;关 → null。 */
export function skipCfgAboveSigma(width: number, height: number, model: string, varietyBoost: boolean): number | null {
  if (!varietyBoost || isNai5(model)) return null;
  const magic = isNai45(model) ? SIGMA_MAGIC_NUMBER_V4_5 : SIGMA_MAGIC_NUMBER;
  return Math.pow((width * height) / REFERENCE_PIXEL_COUNT, 0.5) * magic;
}

/* ============ 地址与基础工具 ============ */

/**
 * 拼端点:base 去掉尾斜杠后补 /ai/<path>;base 本身已是完整端点
 * (以 /ai/<path> 或 /<path> 结尾)时原样使用,方便第三方站给整段 URL。
 */
export function naiEndpoint(url: string, path: string): string {
  const base = url.trim().replace(/\/+$/, '');
  if (!base) throw new NaiError('请先填写 NAI 接口地址');
  const seg = path.replace(/^\/+/, '');
  if (base.endsWith(`/ai/${seg}`) || base.endsWith(`/${seg}`)) return base;
  return `${base}/ai/${seg}`;
}

export interface NaiSize {
  width: number;
  height: number;
}

/** 解析「832×1216 / 832x1216」;宽高须为 64 的倍数、256–2048。 */
export function parseResolution(text: string): NaiSize {
  const size = parseSize(text);
  if (!size) throw new NaiError(`分辨率格式无效:${text || '(空)'};应如 832×1216`);
  const { width, height } = size;
  if (width % 64 !== 0 || height % 64 !== 0) {
    throw new NaiError(`分辨率 ${width}×${height} 不是 64 的倍数,NAI 要求宽高均为 64 的倍数`);
  }
  if (width < 256 || height < 256 || width > 2048 || height > 2048) {
    throw new NaiError(`分辨率 ${width}×${height} 超出 NAI 允许范围(256–2048)`);
  }
  return { width, height };
}

/** NAI 种子是 32 位无符号整数(与 ComfyUI 的 2^53 不同,不能复用 randomSeed)。 */
export function naiRandomSeed(): number {
  return Math.floor(Math.random() * 2 ** 32);
}

function uint8ToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ============ payload 构造(纯函数,可测) ============ */

export interface NaiGenerateValues {
  /** 正向 tag(不含质量词)。 */
  prompt: string;
  nl?: string;
  characters?: ImageCharacterPrompt[];
  /** 种子;缺省随机。 */
  seed?: number;
  /** 画幅方向;缺省竖屏(与改动前的固定默认一致)。 */
  size?: Orientation;
}

type JsonObject = Record<string, unknown>;

/**
 * 当前生效的画师串:选中条目的 prompt;未选 / 指向已删条目 / 内容全空白 → 空串。
 *
 * 刻意吃 nai 而不读全局 settings:本文件的拼装函数都是纯函数、可单测,读全局会让测试
 * 没法用 nai() 工厂控制输入。也刻意不 import state/settings 的 activeNaiArtist ——
 * settings.ts 已 import 本模块的 naiDefaultUndesired,反向加值依赖会成运行时环(TDZ 隐患)。
 * 这一行 find 的重复是有意为之。
 */
export function naiArtistPrompt(nai: NaiSettings): string {
  if (!nai.activeArtistId) return '';
  const preset = nai.artistPresets.find(a => a.id === nai.activeArtistId);
  // 全空白的 preset 必须归空串:'   ' 是 truthy,下游 filter(Boolean) 兜不住它
  return preset?.prompt.trim() ?? '';
}

/**
 * 正向完整 prompt:画师串在最前,画面 tag 居中,质量词在最后。
 * - 画师串 = 画师串库当前选中条目(未选则无)。放最前是因为它决定整幅画的画风基调,
 *   NAI 对靠前 tag 的权重更高;
 * - 质量词 = 用户覆盖值(qualityTags)优先,留空则按模型取官方词。
 *
 * ⚠ 本函数在 buildNaiParameters(v4_prompt 的来源)与 generateNaiImage 的顶层 input
 * 字段处各调一次,两处必须同源。拼装改动一律留在本函数内部——在某个调用点单独加料会让
 * NAI3(读 input)与 NAI4/4.5(读 v4_prompt)拿到不同的提示词,且只在 NAI3 上暴露。
 */
export function fullPositivePrompt(nai: NaiSettings, prompt: string, nl = ''): string {
  const artist = naiArtistPrompt(nai);
  const quality = nai.qualityTags.trim() || naiDefaultQualityTags(nai.model);
  const tags = [artist, prompt.trim(), quality].filter(Boolean).join(', ');
  return isNai5(nai.model) && nl.trim() ? `${tags}. ${nl.trim()}` : tags;
}

function characterCaption(character: ImageCharacterPrompt): string {
  // Character Prompts identify one subject: library count tags (1girl/1boy) become girl/boy here.
  const tag = character.tag
    .split(',')
    .map(part => {
      const value = part.trim();
      if (/^\d+\s*girls?$/i.test(value)) return 'girl';
      if (/^\d+\s*boys?$/i.test(value)) return 'boy';
      return value;
    })
    .filter(Boolean)
    .join(', ');
  return character.nl.trim() ? `${tag}. ${character.nl.trim()}` : tag;
}

/**
 * 负面完整 prompt = 用户覆盖值(undesiredContent),留空则按模型取官方负面词。
 * 想额外排除什么,直接往这一份里接——故不再有单独的「附加负面」字段。
 */
export function fullNegativePrompt(nai: NaiSettings): string {
  return nai.undesiredContent.trim() || naiDefaultUndesired(nai.model);
}

/**
 * 构造 parameters。v4 系模型带 v4_prompt/v4_negative_prompt 结构;NAI3 不带。
 * vibe 不在此叠加(见 applyVibes),保持「一次生成 = build + applyVibes」两步。
 */
export function buildNaiParameters(nai: NaiSettings, values: NaiGenerateValues): JsonObject {
  // 画幅按方向取用户配的那一格;没填回落竖屏默认
  const orientation = values.size ?? 'portrait';
  const { width, height } = parseResolution(pickSize(nai, orientation) || '832×1216');
  // 显式传入 > 面板固定种子 > 随机
  const seed = values.seed ?? (nai.seed > 0 ? nai.seed : naiRandomSeed());
  const prompt = fullPositivePrompt(nai, values.prompt, values.nl);
  const negative = fullNegativePrompt(nai);
  const skipCfg = skipCfgAboveSigma(width, height, nai.model, nai.varietyBoost);
  const sampler = isNai5(nai.model) && !NAI_V5_SAMPLERS.has(nai.sampler) ? 'k_euler_ancestral' : nai.sampler;

  const params: JsonObject = {
    params_version: isNai5(nai.model) ? 4 : 3,
    width,
    height,
    scale: nai.scale,
    sampler,
    steps: nai.steps,
    n_samples: 1,
    // 提示词已由本地固定默认拼好；协议字段保持官方前端口径。
    ucPreset: 3,
    qualityToggle: true,
    dynamic_thresholding: false,
    controlnet_strength: 1,
    legacy: false,
    legacy_uc: false,
    add_original_image: true,
    cfg_rescale: nai.cfgRescale,
    noise_schedule: nai.noiseSchedule,
    skip_cfg_above_sigma: skipCfg,
    legacy_v3_extend: false,
    stream: 'msgpack',
    seed,
    negative_prompt: negative,
    reference_strength_multiple: [],
    normalize_reference_strength_multiple: nai.normalizeRefStrength,
    use_coords: false,
  };

  if (isNai3(nai.model)) {
    // NAI3:vibe 直接发参考原图;SME/SMEA 暂不开放(固定关)
    params.sm = false;
    params.sm_dyn = false;
    params.reference_image_multiple = [];
    params.reference_information_extracted_multiple = [];
  } else {
    // NAI4/4.5/V5: v4 caption structure; Vibe uses a model-specific cached encoding.
    params.reference_image_multiple_cached = [];
    const charCaptions = isNai5(nai.model)
      ? (values.characters ?? []).map(character => ({
          char_caption: characterCaption(character),
          centers: [{ x: 0.5, y: 0.5 }],
        }))
      : [];
    params.characterPrompts = [];
    params.v4_prompt = {
      caption: { base_caption: prompt, char_captions: charCaptions },
      use_coords: false,
      use_order: true,
    };
    params.v4_negative_prompt = {
      caption: {
        base_caption: negative,
        char_captions: charCaptions.map(() => ({ char_caption: '', centers: [{ x: 0.5, y: 0.5 }] })),
      },
      legacy_uc: false,
    };
  }

  if (sampler === 'k_euler_ancestral') {
    params.deliberate_euler_ancestral_bug = false;
    params.prefer_brownian = true;
  }
  return params;
}

/** vibe 模型 key:encodings 分组的键(与官方 .naiv4vibe 一致)。 */
export function vibeModelKey(model: string): string {
  if (model.includes('nai-diffusion-5-curated')) return 'v5curated';
  if (model.includes('nai-diffusion-5-full')) return 'v5full';
  if (model.includes('4-5-curated')) return 'v4-5curated';
  if (model.includes('4-5-full')) return 'v4-5full';
  if (model.includes('4-curated')) return 'v4curated';
  if (model.includes('4-full')) return 'v4full';
  if (model.includes('diffusion-3')) return 'v3';
  return 'v4-5full';
}

/**
 * 把启用的 vibe 叠加进 parameters。
 * - NAI3:参考原图进 reference_image_multiple(配信息提取度 1 + 强度);
 * - NAI4/4.5:编码数据进 reference_image_multiple_cached(随机 cache key),强度并进
 *   reference_strength_multiple;强度总和超过 1 且开启归一化时按比例压回 1。
 * 返回被跳过的 vibe 名(缺当前模型编码/缺原图),调用方据以提示。
 */
export function applyVibes(
  params: JsonObject,
  nai: NaiSettings,
  dataById: ReadonlyMap<string, NaiVibeData>,
): string[] {
  const active = nai.vibes.filter(v => v.enabled);
  if (!active.length) return [];
  if (!naiSupportsVibes(nai.model)) return active.map(vibe => vibe.name);
  const skipped: string[] = [];
  const strengths = params.reference_strength_multiple as number[];

  if (isNai3(nai.model)) {
    const images = params.reference_image_multiple as string[];
    const infos = params.reference_information_extracted_multiple as number[];
    for (const vibe of active) {
      const data = dataById.get(vibe.id);
      if (!data?.image) {
        skipped.push(vibe.name);
        continue;
      }
      images.push(data.image);
      infos.push(1);
      strengths.push(vibe.strength);
    }
    return skipped;
  }

  const cached = params.reference_image_multiple_cached as { cache_secret_key: string; data: string }[];
  const modelKey = vibeModelKey(nai.model);
  const picked: number[] = [];
  for (const vibe of active) {
    const enc = dataById.get(vibe.id)?.encodings[modelKey];
    if (!enc?.encoding) {
      skipped.push(vibe.name);
      continue;
    }
    cached.push({ cache_secret_key: randomUuid(), data: enc.encoding });
    picked.push(vibe.strength);
  }
  // 归一化:总强度 > 1 时按比例压回 1(st-chatu8 同口径;4.5 开归一化时官方端也会自动处理)
  const total = picked.reduce((s, x) => s + x, 0);
  const scale = nai.normalizeRefStrength && total > 1 ? 1 / total : 1;
  for (const s of picked) strengths.push(s * scale);
  return skipped;
}

/* ============ 网络请求 ============ */

async function naiHttpError(resp: Response, label: string): Promise<NaiError> {
  const text = (await resp.text().catch(() => '')).trim();
  let detail = text;
  try {
    const json = JSON.parse(text);
    if (typeof json?.message === 'string') detail = json.message;
  } catch {
    /* 非 JSON 错误体直接用原文 */
  }
  switch (resp.status) {
    case 400:
      return new NaiError(`${label}:请求校验失败:${detail.slice(0, 300)}`, resp.status);
    case 401:
      return new NaiError(`${label}:API Key 错误或无效`, resp.status);
    case 402:
      return new NaiError(`${label}:需要有效订阅(402)`, resp.status);
    case 429:
      return new NaiError(`${label}:请求过于频繁(429),请稍候再试`, resp.status);
    default:
      return new NaiError(`${label} (${resp.status}):${detail.slice(0, 300)}`, resp.status);
  }
}

/** 测试连接:优先 /user/subscription 验 key;第三方站无此接口(404)时只验证地址可达。 */
export async function testNaiConnection(
  nai: Pick<NaiSettings, 'url' | 'key'>,
  signal?: AbortSignal,
): Promise<{ message: string }> {
  if (!nai.key.trim()) throw new NaiError('请先填写 API Key');
  const resp = await fetch(naiEndpoint(nai.url, 'user/subscription'), {
    headers: { Authorization: `Bearer ${nai.key.trim()}` },
    signal,
  });
  if (resp.status === 404) {
    return { message: '地址可达,但无订阅接口(第三方站);请以实际生图验证' };
  }
  if (!resp.ok) throw await naiHttpError(resp, '连接 NAI 失败');
  const data = (await resp.json().catch(() => null)) as {
    tier?: number;
    active?: boolean;
    subscription?: { tier?: number; active?: boolean; expiresAt?: number };
  } | null;
  const tier = data?.subscription?.tier ?? data?.tier;
  const active = data?.subscription?.active ?? data?.active;
  const tierName = ['Free', 'Tablet', 'Scroll', 'Opus'][Number(tier)] ?? `Tier ${tier}`;
  return {
    message: `连接正常:${tierName}${active === false ? '(订阅未激活)' : ''}`,
  };
}

/** 解 NAI 返回的 zip,取第一张图转 base64。 */
export function unzipNaiImage(buffer: ArrayBuffer): { base64: string; filename: string } {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buffer));
  } catch {
    throw new NaiError('响应不是有效的 zip 包(第三方站可能返回了其他格式)');
  }
  const name = Object.keys(files).find(n => /\.(png|jpe?g|webp)$/i.test(n)) ?? Object.keys(files)[0];
  if (!name) throw new NaiError('zip 包内没有图片文件');
  return { base64: uint8ToBase64(files[name]), filename: name };
}

/**
 * 生图。返回与 ComfyImageResult 同构的结果(dataURL 形式),楼层卡片/落盘层可直接复用。
 */
export async function generateNaiImage(
  nai: NaiSettings,
  values: NaiGenerateValues,
  signal?: AbortSignal,
): Promise<ComfyImageResult> {
  if (!nai.key.trim()) throw new NaiError('请先填写 NAI API Key');
  if (!values.prompt.trim()) throw new NaiError('正向提示词不能为空');

  const params = buildNaiParameters(nai, values);
  const activeVibes = naiSupportsVibes(nai.model) ? nai.vibes.filter(vibe => vibe.enabled) : [];
  const loaded = new Map<string, NaiVibeData>();
  for (const vibe of activeVibes) {
    try {
      const data = await loadVibeData(vibe);
      loaded.set(
        vibe.id,
        isNai3(nai.model)
          ? data
          : {
              image: '',
              thumbnail: '',
              encodings: data.encodings,
            },
      );
    } catch (error) {
      console.warn(`[柏宝绘] 读取 vibe「${vibe.name}」失败:`, error);
    }
  }
  const skipped = applyVibes(params, nai, loaded);
  if (skipped.length) {
    const reason = naiSupportsVibes(nai.model) ? '缺当前模型编码' : '当前模型不支持 Vibe Transfer';
    console.warn(`[柏宝绘] 以下 vibe 因${reason}被跳过:`, skipped);
    toastr.warning(`vibe「${skipped.join('、')}」${reason},已跳过`, '柏宝绘');
  }

  const body = {
    input: fullPositivePrompt(nai, values.prompt, values.nl),
    model: nai.model,
    action: 'generate',
    parameters: params,
    use_new_shared_trial: true,
  };
  const resp = await fetch(naiEndpoint(nai.url, 'generate-image'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${nai.key.trim()}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) throw await naiHttpError(resp, 'NAI 生图失败');

  const { base64, filename } = unzipNaiImage(await resp.arrayBuffer());
  const format = filename.split('.').pop()?.toLowerCase() || 'png';
  return {
    url: `data:image/${format === 'jpg' ? 'jpeg' : format};base64,${base64}`,
    filename: `nai-${Date.now()}.${format}`,
    format,
    revoke() {},
  };
}

/* ============ vibe 编码与 .naiv4vibe 互通 ============ */

/** 官方 .naiv4vibe 里 encoding 的固定内层 key(与 st-chatu8 同)。 */
export const VIBE_ENCODING_KEY = 'b36a8472fe418d9f80d6bb1c54e3a6e62c62936aa7bf31dae2bcf7e929f6430f';

/**
 * 调 /ai/encode-vibe 把参考图编码成 vibe 数据(base64)。
 * NAI4/4.5 的 vibe 必须经此编码;NAI3 不需要(直接发原图)。
 */
export async function encodeVibeImage(
  nai: Pick<NaiSettings, 'url' | 'key'>,
  imageBase64: string,
  model: string,
  infoExtracted = 1,
  signal?: AbortSignal,
): Promise<string> {
  if (!nai.key.trim()) throw new NaiError('请先填写 NAI API Key');
  const resp = await fetch(naiEndpoint(nai.url, 'encode-vibe'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${nai.key.trim()}`,
    },
    body: JSON.stringify({ image: imageBase64, information_extracted: infoExtracted, model }),
    signal,
  });
  if (!resp.ok) throw await naiHttpError(resp, 'vibe 编码失败');
  const bytes = new Uint8Array(await resp.arrayBuffer());
  if (bytes.length < 100) {
    throw new NaiError(`vibe 编码数据异常(仅 ${bytes.length} 字节),接口可能返回了错误响应`);
  }
  return uint8ToBase64(bytes);
}

export interface ImportedVibe {
  name: string;
  image: string;
  thumbnail: string;
  encodings: NaiVibeEncodings;
  strength: number;
}

/** 解析 .naiv4vibe 文件文本(JSON)为 vibe 条目(不含 id,由调用方补)。 */
export function parseNaiv4vibe(text: string): ImportedVibe {
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new NaiError('不是有效的 .naiv4vibe 文件(JSON 解析失败)');
  }
  if (json?.identifier !== 'novelai-vibe-transfer') {
    throw new NaiError('不是 NovelAI vibe 文件(缺少 novelai-vibe-transfer 标识)');
  }
  const encodings: NaiVibeEncodings = {};
  for (const [modelKey, group] of Object.entries(json.encodings ?? {})) {
    const first = Object.values(group as Record<string, any>)[0];
    if (typeof first?.encoding === 'string' && first.encoding) {
      encodings[modelKey] = {
        encoding: first.encoding,
        infoExtracted:
          typeof first.params?.information_extracted === 'number'
            ? first.params.information_extracted
            : 1,
      };
    }
  }
  if (!Object.keys(encodings).length) throw new NaiError('vibe 文件里没有可用的编码数据');
  return {
    name: typeof json.name === 'string' && json.name ? json.name : '导入的 Vibe',
    image: typeof json.image === 'string' ? json.image : '',
    thumbnail: typeof json.thumbnail === 'string' ? json.thumbnail : '',
    encodings,
    strength: clampVibeStrength(json.importInfo?.strength),
  };
}

/** 导出为官方兼容的 .naiv4vibe JSON(全部已编码模型一并带上)。 */
export async function buildNaiv4vibe(vibe: NaiVibe, data: NaiVibeData): Promise<string> {
  const encodings: Record<string, unknown> = {};
  for (const [modelKey, enc] of Object.entries(data.encodings)) {
    encodings[modelKey] = {
      [VIBE_ENCODING_KEY]: {
        encoding: enc.encoding,
        params: { information_extracted: enc.infoExtracted },
      },
    };
  }
  const id = data.image ? await sha256Hex(data.image) : randomUuid();
  return JSON.stringify({
    identifier: 'novelai-vibe-transfer',
    version: 1,
    type: 'image',
    image: data.image,
    id,
    encodings,
    name: vibe.name,
    thumbnail: data.thumbnail,
    createdAt: Date.now(),
    importInfo: {
      model: Object.keys(data.encodings)[0] ?? '',
      information_extracted: 1,
      strength: vibe.strength,
    },
  });
}

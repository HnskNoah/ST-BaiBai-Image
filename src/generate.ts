/**
 * 「一次出图」的共用中段 —— 楼层卡片与公开接口的唯一生成入口。
 *
 * 原本这段活全写在 Card.vue 的 generate() 里,与槽位运行态(beginGen/failGen)、
 * 落盘(saveImageResult)、重水合(hydrateMessage)缠在一起。公开接口要让第三方
 * 「自己决定图显示在哪」,要的恰恰是**掐头去尾的中段**:
 *
 *   前(调用方):登记运行态 / 校验参数
 *   ★ 中(本模块):NAI 系闸门 → 按 backend 分派 → 拿到图
 *   后(调用方):落盘、显示、收尾埋点
 *
 * **闸门不可绕过**,这是本模块存在的首要理由:直接调 backends/nai.ts 的
 * generateNaiImage 会跑在 floor/genQueue.ts 的并发闸门与全局节奏之外,0.2.0 整版的
 * NAI 限流自愈(429 全局冷却、相邻请求最小间隔、退避重试)当场失效。第三方并发调用
 * 是常态,绕过去的症状是用户 NAI 账号吃一串密集 429 —— 而用户只会认为柏宝绘坏了。
 * 故公开接口与卡片共用本函数,闸门在这里包死。
 *
 * 本模块**刻意不碰**:楼层坐标、genState、extra、水合、请求历史埋点。
 * 埋点留给调用方是有意为之:一条历史记录的「成功」判据各家不同——楼层卡片要等
 * saveImageResult 落盘成功才算成,还要把「图拿到了却因任务被取代而丢弃」记成已取消;
 * 本模块只知道请求本身的成败,替调用方下结论会把那两种情形谎报成成功。
 * 故 decideSeed 单独导出:调用方先定种子(埋点需要它)、再把它显式传进来。
 */

import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import { validateSimpleConfig } from '@/backends/comfyTemplates';
import { generateComfyImage, randomSeed, type ComfyImageResult } from '@/backends/comfyui';
import {
  generateNaiImage,
  latentDefaultUndesired,
  naiRandomSeed,
  naiSupportsCharacterPrompts,
} from '@/backends/nai';
import type { Orientation } from '@/backends/size';
import { acquireNaiSlot } from '@/floor/genQueue';
import {
  activeComfyPreset,
  effectiveComfyConn,
  latentAsNai,
  settings,
  type BackendId,
} from '@/state/settings';

/** 一次生成的输入。与协议层 ImageInsertion 同形,但不含正文位置信息。 */
export interface GenerateInput {
  /** 正向 danbooru 短 tag。 */
  prompt: string;
  /** 自然语言部分(可空)。 */
  nl?: string;
  /** 本画面动态负面(可空)。ComfyUI 走 %negative_prompt%;NAI 的负面取渠道配置,不吃这个;Latent(NAI 兼容站)与渠道级负面合并。 */
  negative?: string;
  /** NAI 4.5/V5 原生多角色提示;ComfyUI 不支持(见 charactersApplied)。 */
  characters?: ImageCharacterPrompt[];
  /** 画幅方向;缺省竖屏。具体像素取渠道配置里的横竖尺寸。 */
  size?: Orientation;
  /** 本次种子。由调用方经 decideSeed() 先行确定(埋点要在发请求前拿到它)。 */
  seed: number;
}

/** 生成过程中的进度上报(卡片用它显示排队位置与退避进度)。 */
export interface GenerateProgress {
  /** 已取得闸门槽位、请求即将发出(NAI 从「排队中」进入「生成中」的时机)。 */
  onStart?: () => void;
  /** ComfyUI 服务端队列里前面还有几个;null = 未知。 */
  onQueue?: (ahead: number | null) => void;
  /** NAI 限流退避进度;传 null 表示已不在退避中。 */
  onRetry?: (retry: { attempt: number; max: number } | null) => void;
}

export interface GenerateOutput {
  result: ComfyImageResult;
  /** 本次实际使用的种子(原样回传,调用方不必自己记)。 */
  seed: number;
  backend: BackendId;
  /**
   * characters 是否真的发给了后端。
   * ComfyUI 链路**不支持**多角色提示(comfyui.ts / comfyTemplates.ts 全程不读该字段),
   * 传了也是静默丢弃 —— 故显式回报,调用方据此决定要不要提示用户换后端。
   * 不在这里「降级拼进 prompt」:那正是 0.2.3 修掉的重叠躯干问题(一张图里多份完整外貌)。
   */
  charactersApplied: boolean;
}

/** 后端就绪状态。 */
export interface BackendStatus {
  backend: BackendId;
  configured: boolean;
  /** NAI 为模型名;ComfyUI 为当前工作流预设名。 */
  model: string;
  /** 当前后端是否支持 characters(NAI 4.5/V5 为 true,ComfyUI 恒 false)。 */
  supportsCharacters: boolean;
  /** configured=false 时的人话原因;已就绪为空串。 */
  reason: string;
}

/**
 * 当前后端能不能出图。**唯一判据**,卡片(configured)与公开接口共用。
 *
 * ComfyUI 要按模式分别校验(custom 要工作流 JSON;simple 要模型/VAE/CLIP 选齐,
 * 与出图组装同一口径 validateSimpleConfig,避免「卡片能点、出图才报错」);NAI 要 url + key。
 */
export function backendStatus(): BackendStatus {
  const backend = settings.defaultBackend;

  if (backend === 'nai') {
    const model = settings.nai.model;
    // 支持与否只看模型,与配没配齐无关:第三方要在出图前就知道该不该传 characters
    const supportsCharacters = naiSupportsCharacterPrompts(model);
    const base = { backend, model, supportsCharacters };
    if (!settings.nai.url.trim()) return { ...base, configured: false, reason: '未填写 NAI 服务地址' };
    if (!settings.nai.key.trim()) return { ...base, configured: false, reason: '未填写 NAI API Key' };
    return { ...base, configured: true, reason: '' };
  }

  if (backend === 'comfyui') {
    const preset = activeComfyPreset();
    const base = { backend, model: preset.name, supportsCharacters: false };
    if (!settings.comfyui.url.trim()) {
      return { ...base, configured: false, reason: '未填写 ComfyUI 服务地址' };
    }
    if (preset.mode === 'simple') {
      const invalid = validateSimpleConfig(preset.simple);
      if (invalid) return { ...base, configured: false, reason: invalid };
      return { ...base, configured: true, reason: '' };
    }
    if (!preset.workflow.trim()) {
      return { ...base, configured: false, reason: '当前工作流预设未填写工作流 JSON' };
    }
    return { ...base, configured: true, reason: '' };
  }

  if (backend === 'latent') {
    // Latent 渠道(站点的 NovelAI 兼容面):判据同 NAI(url + key)。
    // supportsCharacters **恒 false**:站点不收 v4_prompt/characterPrompts 这套双层结构
    // (characterPromptsOn 对 latent 恒 false,发送侧 latentFlatPrompt 一律剥掉),人物外貌
    // 是 AI 写进主 tag 串的。报 true 会让公开接口的 charactersApplied 说谎——第三方据此
    // 以为多角色提示生效了,实际载荷里一个 characters 都没有。
    const base = {
      backend,
      model: settings.latent.model,
      supportsCharacters: false,
    };
    if (!settings.latent.url.trim())
      return { ...base, configured: false, reason: '未填写 Latent 渠道服务地址' };
    if (!settings.latent.key.trim())
      return { ...base, configured: false, reason: '未填写 Latent 渠道 API Key' };
    return { ...base, configured: true, reason: '' };
  }

  // webui 只剩存量类型(设置迁移会把它归一成 comfyui/nai),真出现就是「没选后端」
  return {
    backend,
    configured: false,
    model: '',
    supportsCharacters: false,
    reason: '出图后端未选择,请在柏宝绘「渠道」页选择出图渠道',
  };
}

/**
 * 定本次种子。**必须在发请求前定好**:一是部分采样器节点不接受 -1 自动随机,
 * 二是埋点与落盘(entry.seed)都要记下它,事后「同种子再来一张」才有依据。
 *
 * 口径:显式指定 > 面板固定种子(>0)> 随机。
 * 随机兜底:NAI 与 Latent 都取 naiRandomSeed(32 位无符号,NAI 协议域)。Latent 站点
 * 原生域更宽(0–2^53-1,settings.latent.test.ts 已锁 2^32 可用),但那是**显式值**的事——
 * override 原样透传,随机取 32 位子集无害。不能用 comfy 的 randomSeed(超站点域)。
 */
export function decideSeed(backend: BackendId, override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) return Math.floor(override);
  if (backend === 'nai') return settings.nai.seed > 0 ? settings.nai.seed : naiRandomSeed();
  if (backend === 'latent') return settings.latent.seed > 0 ? settings.latent.seed : naiRandomSeed();
  return randomSeed();
}

/**
 * 按当前设置出一张图。**楼层卡片与公开接口的唯一生成路径。**
 *
 * 不负责落盘、不负责显示、不登记运行态、不做埋点 —— 那些是调用方的事。
 * signal 一路透传到 fetch/轮询;取消时抛 AbortError(DOMException)。
 *
 * 闸门纪律(见 floor/genQueue.ts):NAI 系路径(nai 与 latent)必须持槽发请求,release
 * 放在 finally,漏一格就永久少一格并发。
 */
export async function generateImage(
  input: GenerateInput,
  signal?: AbortSignal,
  progress: GenerateProgress = {},
): Promise<GenerateOutput> {
  const status = backendStatus();
  // 兜底:卡片侧已用 configured 拦在按钮上,公开接口侧也会先报 not_configured。
  // 真漏到这里说明上游判据漂了,宁可明说也别发一个注定 401/404 的请求。
  if (!status.configured) throw new Error(status.reason || '出图后端未配置');

  const isNai = status.backend === 'nai';
  const isLatent = status.backend === 'latent';
  const characters = input.characters ?? [];
  // 支持与否由后端说了算:ComfyUI 恒不支持;NAI/Latent 看模型是否 4.5/V5
  const charactersApplied = characters.length > 0 && status.supportsCharacters;

  // Latent 渠道:完全复用 NAI 机器(latentAsNai 映射后走 generateNaiImage),站点原生面
  // 的差异全在这一段兜住(别搬回调用方——卡片与公开接口共用本函数)。
  // 负面 = naiUndesiredContent 链(画师串绑定词 > 渠道级 negativePrompt > Anima 推荐默认
  // latentDefaultUndesired,启用画师串时自动剔掉 artist name);本画面 <negative> **不在这里拼**
  // ——链在 buildNaiParameters 里才求值,提前拼进 undesiredContent 会被画师串绑定值短路掉
  // (`bound || …`),本画面负面整个丢失(实测:绑定 boundneg + 本画面 outdoor → 载荷只剩 boundneg)。
  // 改由 values.negativeExtra 在链值之后合并 + 去重(见 nai.ts 的 mergeNegativePrompts)。
  // 无本地长度上限(站长确认站点支持超 2000 字符)。
  const latentView = isLatent ? latentAsNai(settings.latent) : null;

  let release: (() => void) | null = null;
  try {
    // 持槽:取到槽位后本函数内一直持有,直到 finally 释放。
    // NAI 系(nai 与 latent)同为阻塞式 POST、无服务端队列,共用本闸门——latent 站点
    // 在途超限是 409,堵住这一面同样要靠它(见 floor/genQueue.ts)。
    if (isNai || isLatent) release = await acquireNaiSlot(signal);
    progress.onStart?.();

    const size = input.size ?? 'portrait';
    const result = isNai
      ? await generateNaiImage(
          settings.nai,
          // characters 原样透传:不支持的模型由 buildNaiParameters 自己滤掉(同一口径
          // naiSupportsCharacterPrompts),在这儿再滤一遍只会多一处会漂的判据
          { prompt: input.prompt, nl: input.nl ?? '', characters, seed: input.seed, size },
          signal,
          { onRetry: info => progress.onRetry?.({ attempt: info.attempt, max: info.max }) },
        )
      : latentView
        ? await generateNaiImage(
            latentView,
            {
              prompt: input.prompt,
              nl: input.nl ?? '',
              characters,
              seed: input.seed,
              size,
              // 本画面负面:在链值之后合并 + 去重,不会被画师串绑定值顶掉
              negativeExtra: (input.negative ?? '').trim(),
              // Anima 分册回落:留空时替换「模型官方词」那一级(链在 buildNaiParameters 里求值)
              negativeFallback: latentDefaultUndesired(latentView),
            },
            signal,
            {
              // 站点 429 = 周配额耗尽(openapi quota_exhausted),退避等不来额度,与配置
              // 错误同类立刻抛;NAI 官方 429 = 限流,照旧退避。
              noRetry429: true,
              // 站点原生档尺寸(920×1536 等)不是 64 的倍数,豁免协议校验(格式/范围检查仍生效)。
              allowNon64Size: true,
              // 扁平 prompt 串:tag + nl 拼一段,剥掉 v4_prompt 系双层结构。
              latentFlatPrompt: true,
              // 站点原生面收分辨率枚举(portrait/landscape)而非宽高数字对。
              latentResolution: size === 'landscape' ? 'landscape' : 'portrait',
              onRetry: info => progress.onRetry?.({ attempt: info.attempt, max: info.max }),
            },
          )
        : await generateComfyImage(
            effectiveComfyConn(),
            {
              prompt: input.prompt,
              nl: input.nl ?? '',
              negative_prompt: input.negative ?? '',
              seed: input.seed,
              size,
            },
            signal,
            { onQueue: ahead => progress.onQueue?.(ahead) },
          );

    // 退避文案到此为止:图已拿到,落盘还要一会儿,不该继续显示「稍后重试」
    progress.onRetry?.(null);
    return { result, seed: input.seed, backend: status.backend, charactersApplied };
  } finally {
    release?.();
  }
}

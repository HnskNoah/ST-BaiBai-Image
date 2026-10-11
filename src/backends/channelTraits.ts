/**
 * 渠道特性表:一次算清「当前出图渠道吃哪套协议」,判据只此一处。
 *
 * 【为什么存在】latent 渠道复用 NAI 的出图机器(latentAsNai 映射后走 generateNaiImage),
 * 于是「渠道是谁」的特判散进了判据层、文本层与出图层。代价是上游每次重构 NAI/ComfyUI
 * 两分支,这些特判就一起断——0.3.2 一次就删掉了 isNaiFamilyBackend / characterPromptsOn /
 * tagLintMode 三个导出。本模块把渠道差异收成一张表:消费方只问特性、不问渠道名,
 * 上游再加渠道级开关时,改动落在这一个文件里而不是全仓找特判。
 *
 * 【两层】channelTraits 是纯函数(入参显式,不读 settings),判据可以直接单测;
 * activeChannelTraits 是读 settings 的薄封装,只负责取值、不含判据。两个调用点
 * (prompt.ts 写协议、runner.ts 验收与收尾)一律走薄封装,免得各自拼入参时漏一项——
 * 漏了就是「协议说只写 tag,验收却还在要 nl」那类漂移。
 */
import type { TagLintMode } from '@/autoTag/taglint';
import { naiSupportsCharacterPrompts } from '@/backends/nai';
import type { Orientation, OrientationLock } from '@/backends/size';
import {
  activeComfyPreset,
  activeOrientationLock,
  settings,
  type BackendId,
} from '@/state/settings';

/**
 * 规范与思维链取哪一份文本。设置页的用户键与内置默认按此配对(见 prompt.ts 的
 * backendPromptSpec / backendThinkingPrompt):
 * - comfy    :ComfyUI 工作流口径(占位符、邻接绑定)
 * - naiV5    :NAI 4.5/V5 的 Base + Character Prompts 口径
 * - naiSingle:NAI 4.5 以下的遗留单串口径(模型列表收窄后不可达,留作回归锁)
 * - latent   :Latent 站点(Anima 系 / Qwen 编码器)的单串 + nl 口径
 */
export type SpecFamily = 'comfy' | 'naiV5' | 'naiSingle' | 'latent';

export interface ChannelTraits {
  channel: BackendId;
  /** 规范文本族;null = 该渠道不下发规范(webui 尚未接入)。 */
  spec: SpecFamily | null;
  /** 思维链文本族(webui 回落 comfy 那份)。 */
  thinking: SpecFamily;
  /**
   * tag 机械修正的模式(见 autoTag/taglint.ts)。**由 spec 族派生,不另算**:
   * naiV5 → 'v5';latent 与 naiSingle 同为单串口径 → 'latent';comfy → 'comfyui'。
   * 派生是为了让「规范说单串、守卫却按 V5 剥词」这类漂移在结构上不可能发生——
   * 旧写法把两个判据分开算,靠注释叮嘱顺序承重。
   */
  lintMode: TagLintMode;
  /**
   * Character Prompts(tag + nl 双键结构)是否生效:只有 NAI 官方渠道 + 4.5/V5 模型。
   * latent 恒否——站点不收 v4_prompt/characterPrompts 这套双层结构(那是 NAI 官方协议),
   * 人物归属由 nl 承担。⚠ 恒否不等于「站点不吃自然语言」,那由 nlAlways / nl 表达。
   */
  charPrompts: boolean;
  /**
   * 恒吃自然语言(与「跟随渠道开关」相对)。latent 站点底层是 Anima 系(Qwen 编码器),
   * 官方口径明确支持 nl:tag 定身份/概念,完整英文句子写服装构造、肢体几何、镜头与空间关系。
   * NAI 的 nl 不是恒真——它要模型支持 CP 且面板开着「生成自然语言」。
   */
  nlAlways: boolean;
  /**
   * 协议是否含 nl(把渠道恒定性、模型支持面与用户开关合到一起后的最终值)。
   * 只管 AI 写不写:已写进 tag 的 nl 照常发送。
   */
  nl: boolean;
  /** 渠道锁定的画幅方向;null = 由 AI 按后端规范的判据自选。 */
  lockedSize: Orientation | null;
  /**
   * 画面级负面随每张图下发(在渠道级负面之外再合一层)。latent 站点有原生 negativePrompt
   * 字段;NAI 官方只有渠道级负面;ComfyUI 的负面取决于工作流有没有 %negative_prompt%,
   * 那是运行时判据,不在本表里(见 prompt.ts 的 negativeOn)。
   */
  frameNegative: boolean;
  /**
   * 出图是否走 NAI 那台机器:latent 经 latentAsNai 映射成 NaiSettings 后复用
   * generateNaiImage,故与 nai 同为真。同时决定并发闸门归属(两者都是阻塞式 POST、
   * 无服务端队列,共用 floor/genQueue.ts 的 NAI 槽位)。
   */
  usesNaiMachine: boolean;
  /**
   * 提示词发扁平单串:tag 与 nl 拼成一段,剥掉 v4_prompt / v4_negative_prompt /
   * characterPrompts 双层结构(兼容层不认那套;characters[].tag 的内容副 API 已按
   * 邻接绑定写进主串,丢弃的是冗余副本而非信息)。
   */
  flatPrompt: boolean;
  /**
   * 画幅的发送形态:'pixels' = width/height 数字对;'orientationEnum' = 站点原生枚举
   * (openapi GenerationRequest.resolution,只有 portrait/landscape 两档,无 square)。
   * 宽高在本地仍用于 skip_cfg 等派生计算,枚举形态只把它们从载荷里移除。
   */
  sizeEncoding: 'pixels' | 'orientationEnum';
  /** 尺寸豁免 64 倍数协议校验(站点固定档 920×1536 不是 64 的倍数;格式与范围检查仍生效)。 */
  allowNon64Size: boolean;
  /**
   * 429 视为配额耗尽而非限流:站点 429 = 周配额用完(openapi quota_exhausted),
   * 退避等不来额度,与配置错误同类立刻抛;NAI 官方 429 是限流,照旧退避。
   */
  noRetry429: boolean;
}

/** 与用户开关无关的那部分特性(nl / lockedSize 由入参决定,不在此列)。 */
type StaticTraits = Omit<ChannelTraits, 'nl' | 'lockedSize'>;

/** latent 站点:单串 + nl,不吃双层结构,画面级负面生效,出图复用 NAI 机器但载荷按站点原生面改。 */
const LATENT: StaticTraits = {
  channel: 'latent',
  spec: 'latent',
  thinking: 'latent',
  lintMode: 'latent',
  charPrompts: false,
  nlAlways: true,
  frameNegative: true,
  usesNaiMachine: true,
  flatPrompt: true,
  sizeEncoding: 'orientationEnum',
  allowNon64Size: true,
  noRetry429: true,
};

const COMFY: StaticTraits = {
  channel: 'comfyui',
  spec: 'comfy',
  thinking: 'comfy',
  lintMode: 'comfyui',
  charPrompts: false,
  nlAlways: false,
  frameNegative: false,
  usesNaiMachine: false,
  flatPrompt: false,
  sizeEncoding: 'pixels',
  allowNon64Size: false,
  noRetry429: false,
};

/**
 * webui 只剩存量类型(设置迁移会把它归一成 comfyui/nai):不下发规范,思维链回落 comfy 那份。
 * 真出现就是「没选后端」,出图侧由 backendStatus 拦住。
 */
const WEBUI: StaticTraits = {
  channel: 'webui',
  spec: null,
  thinking: 'comfy',
  lintMode: 'comfyui',
  charPrompts: false,
  nlAlways: false,
  frameNegative: false,
  usesNaiMachine: false,
  flatPrompt: false,
  sizeEncoding: 'pixels',
  allowNon64Size: false,
  noRetry429: false,
};

/** NAI 官方渠道:出图侧全按协议默认走,差异只在模型与开关决定的 nl / Character Prompts。 */
const NAI_OFFICIAL: StaticTraits = {
  channel: 'nai',
  spec: 'naiV5',
  thinking: 'naiV5',
  lintMode: 'v5',
  charPrompts: true,
  nlAlways: false,
  frameNegative: false,
  usesNaiMachine: true,
  flatPrompt: false,
  sizeEncoding: 'pixels',
  allowNon64Size: false,
  noRetry429: false,
};

/**
 * 遗留单串分支(4.5 以下模型,上游模型列表已收窄、NAI 渠道自身走不到):协议没有 nl 键,
 * 守卫与 latent 同族。独立成常量而不是在 ternary 里现拼对象:现拼的字面量会被收窄成 string,
 * 过不了 SpecFamily 的类型检查;声明成常量才能在定义处就受检。
 */
const NAI_SINGLE: StaticTraits = {
  ...NAI_OFFICIAL,
  spec: 'naiSingle',
  thinking: 'naiSingle',
  lintMode: 'latent',
  charPrompts: false,
};
export interface ChannelTraitsInput {
  /** NAI 渠道的模型名(判 Character Prompts 支持面)。latent 的 model 字段存的也是 NAI 名,
   *  但它的 charPrompts 恒否、与此参数无关。 */
  naiModel: string;
  /** NAI 面板的「生成自然语言」开关;只在 charPrompts 为真时起作用(遗留单串协议不写 nl)。 */
  naiNaturalLanguage: boolean;
  /** ComfyUI 当前工作流预设的「生成自然语言」开关;非 comfy 渠道传 false。 */
  comfyNaturalLanguage: boolean;
  /** 当前渠道的画幅锁('auto' = 不锁,由 AI 按规范判据自选)。 */
  orientationLock: OrientationLock;
}

/** 取指定渠道的特性表。纯函数:判据全在这里,不读 settings(见 activeChannelTraits)。 */
export function channelTraits(channel: BackendId, input: ChannelTraitsInput): ChannelTraits {
  const lockedSize = input.orientationLock === 'auto' ? null : input.orientationLock;
  if (channel === 'latent') return { ...LATENT, nl: true, lockedSize };
  if (channel === 'comfyui') return { ...COMFY, nl: input.comfyNaturalLanguage, lockedSize };
  if (channel !== 'nai') return { ...WEBUI, nl: false, lockedSize };
  const charPrompts = naiSupportsCharacterPrompts(input.naiModel);
  const base = charPrompts ? NAI_OFFICIAL : NAI_SINGLE;
  return {
    ...base,
    // NAI 的 nl 要两个条件同时成立:模型支持 CP(4.5/V5 才有 nl 键)、面板开着开关。
    // 遗留单串分支的协议本来就不写 nl,开关对它不起作用。
    nl: charPrompts && input.naiNaturalLanguage,
    lockedSize,
  };
}

/**
 * 当前渠道的特性表(读 settings 的薄封装)。**两个调用点一律走这里**,别各自拼入参。
 * 画幅锁与自然语言都取自「当前那一个」渠道/预设:切工作流即同时切走两者的口径。
 */
export function activeChannelTraits(): ChannelTraits {
  const channel = settings.defaultBackend;
  return channelTraits(channel, {
    naiModel: settings.nai.model,
    naiNaturalLanguage: settings.nai.naturalLanguage,
    comfyNaturalLanguage: channel === 'comfyui' ? activeComfyPreset().naturalLanguage : false,
    orientationLock: activeOrientationLock(),
  });
}

/**
 * 渠道能力表:一次算清「当前出图渠道吃哪套协议」,判据只此一处。
 *
 * 【为什么存在】latent 渠道复用 NAI 的出图机器(latentAsNai 映射后走 generateNaiImage),
 * 于是「渠道是谁」的特判散进了判据层、文本层与出图层。代价是上游每次重构 NAI/ComfyUI
 * 两分支,这些特判就一起断——0.3.2 一次就删掉了 isNaiFamilyBackend / characterPromptsOn /
 * tagLintMode 三个导出。本模块把渠道差异收成一张表:消费方只问能力、不问渠道名,
 * 上游再加渠道级开关时,改动落在这一个文件里而不是全仓找特判。
 *
 * 【刻意做成纯函数】入参显式(渠道 id + NAI 模型名),不读 settings:判据可以直接单测,
 * 不必改全局设置再还原(见 channelCaps.test.ts)。读 settings 的那一步留给调用方。
 */
import type { TagLintMode } from '@/autoTag/taglint';
import { naiSupportsCharacterPrompts } from '@/backends/nai';
import type { BackendId } from '@/state/settings';

/**
 * 规范与思维链取哪一份文本。设置页的用户键与内置默认按此配对(见 prompt.ts 的
 * backendPromptSpec / backendThinkingPrompt):
 * - comfy    :ComfyUI 工作流口径(占位符、邻接绑定)
 * - naiV5    :NAI 4.5/V5 的 Base + Character Prompts 口径
 * - naiSingle:NAI 4.5 以下的遗留单串口径(模型列表收窄后不可达,留作回归锁)
 * - latent   :Latent 站点(Anima 系 / Qwen 编码器)的单串 + nl 口径
 */
export type SpecFamily = 'comfy' | 'naiV5' | 'naiSingle' | 'latent';

export interface ChannelCaps {
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
   * 人物归属由 nl 承担。⚠ 恒否不等于「站点不吃自然语言」,那由 nlAlways 表达。
   */
  charPrompts: boolean;
  /**
   * 恒吃自然语言(与「跟随渠道开关」相对)。latent 站点底层是 Anima 系(Qwen 编码器),
   * 官方口径明确支持 nl:tag 定身份/概念,完整英文句子写服装构造、肢体几何、镜头与空间关系。
   * NAI 的 nl 不是恒真——它跟着 charPrompts 走(4.5/V5 才有 nl 键)。
   */
  nlAlways: boolean;
  /**
   * 画面级负面随每张图下发(在渠道级负面之外再合一层)。latent 站点有原生 negativePrompt
   * 字段;NAI 官方只有渠道级负面;ComfyUI 的负面取决于工作流有没有 %negative_prompt%,
   * 那是运行时判据,不在本表里(见 prompt.ts 的 negativeOn)。
   */
  frameNegative: boolean;
}

/** latent 站点:单串 + nl,不吃双层结构,画面级负面生效。 */
const LATENT: ChannelCaps = {
  channel: 'latent',
  spec: 'latent',
  thinking: 'latent',
  lintMode: 'latent',
  charPrompts: false,
  nlAlways: true,
  frameNegative: true,
};

const COMFY: ChannelCaps = {
  channel: 'comfyui',
  spec: 'comfy',
  thinking: 'comfy',
  lintMode: 'comfyui',
  charPrompts: false,
  nlAlways: false,
  frameNegative: false,
};

/**
 * webui 只剩存量类型(设置迁移会把它归一成 comfyui/nai):不下发规范,思维链回落 comfy 那份。
 * 真出现就是「没选后端」,出图侧由 backendStatus 拦住。
 */
const WEBUI: ChannelCaps = {
  channel: 'webui',
  spec: null,
  thinking: 'comfy',
  lintMode: 'comfyui',
  charPrompts: false,
  nlAlways: false,
  frameNegative: false,
};

/**
 * 取当前渠道的能力表。
 *
 * @param naiModel NAI 渠道的模型名(判 Character Prompts 支持面)。latent 的 model 字段
 *   存的也是 NAI 名,但它的 charPrompts 恒否、与此参数无关,故调用方一律传 settings.nai.model 即可。
 */
export function channelCaps(channel: BackendId, naiModel: string): ChannelCaps {
  if (channel === 'latent') return LATENT;
  if (channel === 'comfyui') return COMFY;
  if (channel !== 'nai') return WEBUI;
  const charPrompts = naiSupportsCharacterPrompts(naiModel);
  return {
    channel,
    spec: charPrompts ? 'naiV5' : 'naiSingle',
    thinking: charPrompts ? 'naiV5' : 'naiSingle',
    lintMode: charPrompts ? 'v5' : 'latent',
    charPrompts,
    nlAlways: false,
    frameNegative: false,
  };
}

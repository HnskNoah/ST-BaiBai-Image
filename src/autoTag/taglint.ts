/**
 * tag 确定性守卫(出图前的机械兜底)。
 *
 * 【为什么存在】规范里能用确定性规则表达的条款,靠提示词只能压住一部分:实测(移植自
 * xy-baibaohui fork 的七轮实跑回归)显示,表情/视线接 on、锚点自我绑定、同色瞳色写两遍、
 * size 词混进 tag 串、nl 混中文这几类跨模型版本稳定复发。本模块在 parseImagePlan 之后、
 * 写回正文之前做**零语义**的机械修正——模型不听话时,这几条硬规则说了算。
 *
 * 【模式】按规范族分三种,判据在 prompt.ts 的 tagLintMode():
 * - latent :单串口径,且规范**禁止 tag 区归属**(归属全在 nl)。绑定类规则只剥「不许接 on
 *           的词」,合法形态(`white dress on green hair girl`)不动——剥了会丢归属,
 *           而归属本该在 nl,那属于规范层的问题、不该由机械规则替它决定。
 * - comfyui:单串口径,邻接绑定是刚需。绑定类规则同样只剥不该接 on 的词,合法绑定不动。
 * - v5     :Base + Character Prompts。绑定类规则整类跳过(那套结构用 source#/target#),
 *           角色名与 nl 允许中文原名,故 nl 的 CJK 剥除也跳过;去重、size 词、人数词照常。
 *
 * 【不做的事】不生成语义、不猜意图:每条变换都是「这个 tag 不该长这样」的机械判定,
 * 命中即修正并在 details 里留痕(调用方 console.info 上报,不弹 toast)。
 */

/** 规范族(与 prompt.ts 的 tagLintMode() 同源)。 */
export type TagLintMode = 'latent' | 'comfyui' | 'v5';

export interface LintableImage {
  tag: string;
  nl?: string;
  characters: Array<{ tag: string; nl?: string }>;
}

export interface LintResult {
  /** 修正处数(与 details.length 同值,调用方判空用)。 */
  fixed: number;
  /** 每处修正的简述(调试用)。 */
  details: string[];
}

export interface LintOptions {
  mode: TagLintMode;
  /** 日志前缀(如「第 12 楼」);空则只写 P 序号。 */
  where?: string;
}

/**
 * 永远不接 on 的词(规范固定词表:表情 + 视线 + 生理效果词)。命中即把「<词> on ...」
 * 从 on 处截断,词本身保留——`long hair girl looking down on X` 这类称谓前缀形态一并覆盖。
 */
const BARE_WORD_ON_RE = new RegExp(
  '(?:^| )(' +
    [
      'looking at viewer',
      'looking at another',
      'looking away',
      'looking down',
      'looking up',
      'looking back',
      'closed eyes',
      'expressionless',
      'smile',
      'grin',
      'laughing',
      'blush',
      'embarrassed',
      'frown',
      'pout',
      'puffy cheeks',
      'surprised',
      'crying',
      'tears',
      'angry',
      'serious',
      'sad',
      'worried',
      'scared',
      'smug',
      'seductive smile',
      'half-closed eyes',
      'open mouth',
      'clenched teeth',
      'winking',
      'glaring',
      'staring',
      'tongue out',
      'biting lip',
      'drooling',
      'sweat drop',
      'calm',
      'relieved',
      'determined',
      'nervous',
      'neutral',
      'smirk',
      'sweat',
      'wet',
      'messy hair',
    ].join('|') +
    ') on .+$',
  'i',
);

const CJK_RE =
  /[\u2e80-\u2eff\u3000-\u303f\u31c0-\u31ef\u3200-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]+/g;

/** 同人身份 tag 的形态:`character name (copyright name)`,括号未转义时才需要补反斜杠。 */
const FANDOM_SHAPE_RE = /^([a-z0-9][a-z0-9 .'’_\-]*) \(([a-z0-9][a-z0-9 .'’_\-]*)\)$/i;

/** size 词只能写在 size 键:混进 tag 串一律剔除。 */
const SIZE_WORD_RE = /^(?:portrait|landscape)$/i;

/** 自造人数词:danbooru 没有这些词,但语义明确,可直接归一到标准词。 */
const COUNT_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b1man\b/gi, '1boy'],
  [/\b(\d+)men\b/gi, '$1boys'],
  [/\b1woman\b/gi, '1girl'],
  [/\b(\d+)women\b/gi, '$1girls'],
];

/** 非 danbooru 的总数词:只在同一串里已有真人数 tag 时剔除(否则会丢唯一的人数信息)。 */
const BOGUS_COUNT_RE = /^(?:\d+\s*people|multiple people)$/i;
const REAL_COUNT_RE = /\b(?:\d+\s*girls?|\d+\s*boys?|multiple girls|multiple boys|no humans)\b/i;

/** 单条 tag 的机械修正;返回 null 表示无需修改。 */
function fixTag(raw: string, details: string[], where: string, mode: TagLintMode): string | null {
  let tag = raw.trim();
  if (!tag) return null;
  const before = tag;

  if (mode !== 'v5') {
    // 表情/视线/效果词后的 on:从「<词> on」处截断,词保留
    tag = tag.replace(BARE_WORD_ON_RE, ' $1');
    // 发色/瞳色短语接 on:head 以 hair/eyes 结尾时截掉「 on ...」(锚点不许自我绑定)
    const idx = tag.toLowerCase().lastIndexOf(' on ');
    if (idx >= 0) {
      const head = tag.slice(0, idx).trim();
      if (/(?:hair|eyes)$/i.test(head)) tag = head;
    }
    // 同人身份 tag 的括号转义(latent 站点与 CLIP 都按权重语法解析裸圆括号)
    const fandom = FANDOM_SHAPE_RE.exec(tag);
    if (fandom) tag = `${fandom[1]} \\(${fandom[2]}\\)`;
  }

  for (const [pattern, replacement] of COUNT_ALIASES) tag = tag.replace(pattern, replacement);

  tag = tag.replace(/\s{2,}/g, ' ').trim();
  if (tag === before) return null;
  details.push(`${where} "${before}" → "${tag}"`);
  return tag;
}

/** 单个 tag 串(逗号分隔)的修正:逐条 fixTag + size 词剔除 + 同名去重。 */
function fixTagString(raw: string, details: string[], where: string, mode: TagLintMode): string {
  // 兜底判据看**归一后**的原串:1man 这类别名会被换算成 1boy,换算后串里已有真人数 tag
  // 才允许剔除非标准总数词(否则会连唯一的人数信息一起丢掉)
  const normalized = COUNT_ALIASES.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), raw);
  const hasRealCount = REAL_COUNT_RE.test(normalized);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of raw.split(',')) {
    const tag = fixTag(piece, details, where, mode) ?? piece.trim();
    if (!tag) continue;
    if (SIZE_WORD_RE.test(tag)) {
      details.push(`${where} 剔除 size 词 "${tag}"`);
      continue;
    }
    if (BOGUS_COUNT_RE.test(tag) && hasRealCount) {
      details.push(`${where} 剔除自造人数词 "${tag}"`);
      continue;
    }
    const key = tag.toLowerCase();
    if (seen.has(key)) {
      details.push(`${where} 重复剔除 "${tag}"`);
      continue;
    }
    seen.add(key);
    out.push(tag);
  }
  const joined = out.join(', ');
  return joined === raw ? raw : joined;
}

/** nl 的 CJK 剥除(单串模式:规范要求英文 nl;V5 的 nl 允许中文原名,不调用本函数)。 */
function fixNl(raw: string, details: string[], where: string): string {
  if (!CJK_RE.test(raw)) return raw;
  CJK_RE.lastIndex = 0;
  const fixed = raw
    .replace(CJK_RE, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,!?])/g, '$1')
    .trim();
  if (fixed !== raw) details.push(`${where} 剥除中文`);
  return fixed;
}

/**
 * 对一次输出的全部图片做确定性修正;**原地修改**传入的 images 并返回修正报告。
 * 调用时机:parseImagePlan 之后、@占位符替换**之后**、写回正文之前。放在替换之后是必须的:
 * 库里的 fandom 存未转义原文(存储形态),落 tag 才转义,替换进来的库值也得过同一张网。
 */
export function lintImagePlan<T extends LintableImage>(images: T[], opts: LintOptions): LintResult {
  const details: string[] = [];
  const prefix = opts.where ? `${opts.where} ` : '';
  for (let idx = 0; idx < images.length; idx++) {
    const image = images[idx];
    const where = `${prefix}P${idx + 1}`;
    const fixedTag = fixTagString(image.tag, details, `${where} tag`, opts.mode);
    if (fixedTag !== image.tag) image.tag = fixedTag;
    if (image.nl && opts.mode !== 'v5') {
      const fixedNl = fixNl(image.nl, details, `${where} nl`);
      if (fixedNl !== image.nl) image.nl = fixedNl;
    }
    const characters = image.characters ?? [];
    for (let ci = 0; ci < characters.length; ci++) {
      const character = characters[ci];
      const fixedCharTag = fixTagString(character.tag, details, `${where} 角色${ci + 1} tag`, opts.mode);
      if (fixedCharTag !== character.tag) character.tag = fixedCharTag;
    }
  }
  return { fixed: details.length, details };
}

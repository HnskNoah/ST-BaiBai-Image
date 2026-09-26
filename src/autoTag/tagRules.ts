import { normalizeBlockedFragments } from '@/state/charTags';

/**
 * 联动加词:命中触发词就往正/负面提示词里追加配套词(如命中 nsfw → 正面加 uncensored)。
 *
 * 【在哪条缝上】runner 的「写回正文之前」,**在 taglint 之后**:机械修正只管纠正模型输出,
 * 不该动用户手配的词。注入结果落进 `<bbi_image>` 的 `tag` / `negative` 子标签,故正文、
 * 图库侧写、「复制提示词」看到的都是实际用的词。**手动编辑弹窗「应用」与公开接口不经这条缝**
 * —— 用户自己编辑的内容不重跑规则(既定口径,见 architecture.md)。
 *
 * 【匹配口径】与角色屏蔽栏同一套:**逗号分段、逐段 trim、大小写不敏感、整段精确**
 * (「nude」不波及「nudity」);触发词与注入词都允许一条规则里写多个(逗号分隔),任一触发
 * 词命中即触发。词的清洗直接复用屏蔽栏那份(剥尖括号防伪造子标签 + 按小写去重)。
 *
 * 【单遍】匹配只看调用那一刻的原串:本次注入的词**不参与**后续规则的匹配,故规则之间
 * 不会互相点火,规则表顺序只影响注入先后、不影响命中。
 *
 * 【不做的事】不生成语义、不猜意图;不碰 nl / 画师串 / 质量词 / `characters[]`;
 * 不跨区去重——注入词同时也在渠道级词里时,最终串可能出现两次(负面方向在 Latent 渠道
 * 还会被 backends/nai.ts 的 mergeNegativePrompts 去重一次,所以重复只可能发生在正面)。
 */

/** 一条规则作用的目标区:正面 tag,或本画面负面(`<negative>` 子标签)。 */
export type TagRuleTarget = 'positive' | 'negative';

export interface TagRule {
  id: string;
  /** 显示名(列表行与注入日志用;允许重名,以 id 为键)。 */
  name: string;
  /** 触发词:逗号分段的整段精确匹配,任一命中即触发。 */
  triggers: string[];
  /** 要注入的词:逗号分隔的多个词会被逐个追加(已在目标串里的不重复加)。 */
  add: string[];
  target: TagRuleTarget;
  enabled: boolean;
}

/** 规则可作用的最小形状:协议层的 ImageInsertion 天然满足,故泛型保形。 */
export interface TagRuleImage {
  tag: string;
  negative?: string;
}

export interface TagRuleOutcome<T> {
  image: T;
  /** 本次注入明细(供调用方上报,不弹 toast):「规则名(触发词): +词 → 正面」。 */
  applied: string[];
}

/** 逗号分段 + trim + 去空(与屏蔽栏同款分段口径)。 */
function tagSegments(text: string): string[] {
  return text
    .split(',')
    .map(segment => segment.trim())
    .filter(Boolean);
}

let tagRuleSeq = 0;

/** 新建一条空规则(id 口径同 newNaiArtist/newNaiEndpoint;rule_ 前缀不与 art_/nep_/conn_ 撞)。 */
export function newTagRule(name = '新规则'): TagRule {
  tagRuleSeq += 1;
  return { id: `rule_${Date.now()}_${tagRuleSeq}`, name, triggers: [], add: [], target: 'positive', enabled: true };
}

/**
 * 单条规则清洗:缺字段/类型不符逐项回退。
 * - `triggers` / `add` 走屏蔽栏那份词表清洗(trim、去空、剥尖括号、按小写去重保留首现写法);
 * - `target` 只认 'negative',其余一律 'positive'(旧数据/手改 JSON 塞脏值不会静默变成负面);
 * - `enabled` 非 boolean 时按 true——规则是用户显式新建的,默认应该生效。
 */
function normalizeTagRule(raw: unknown, seq: number): TagRule {
  const o = (raw ?? {}) as Partial<TagRule>;
  return {
    id: typeof o.id === 'string' && o.id ? o.id : `rule_${Date.now()}_${seq}`,
    name: typeof o.name === 'string' && o.name.trim() ? o.name.trim() : `规则 ${seq + 1}`,
    triggers: normalizeBlockedFragments(o.triggers),
    add: normalizeBlockedFragments(o.add),
    target: o.target === 'negative' ? 'negative' : 'positive',
    enabled: typeof o.enabled === 'boolean' ? o.enabled : true,
  };
}

/** 规则表清洗(normalize 重建表里必须显式接住这份字段,否则载入即剥、首次写回永久丢)。 */
export function normalizeTagRules(raw: unknown): TagRule[] {
  return Array.isArray(raw) ? raw.map((item, seq) => normalizeTagRule(item, seq)) : [];
}

/**
 * 应用规则表,返回**新对象**与注入明细;没有任何注入时原样返回入参(调用方无需走快路径判断)。
 *
 * 注入位置一律是目标串**末尾**:正面 tag 的末尾即画面 tag 区结尾(NAI 拼装时质量词在后面,
 * latent 拼装时 nl 在后面,注入词都不会被顶掉);负面末尾即 `<negative>` 子标签结尾。
 */
export function applyTagRules<T extends TagRuleImage>(
  image: T,
  rules: readonly TagRule[],
): TagRuleOutcome<T> {
  const hitPool = new Set(tagSegments(image.tag).map(segment => segment.toLowerCase()));
  let tag = image.tag;
  let negative = image.negative ?? '';
  const applied: string[] = [];

  for (const rule of rules) {
    if (!rule.enabled || !rule.add.length) continue;
    const hit = rule.triggers.find(trigger => hitPool.has(trigger.toLowerCase()));
    if (!hit) continue;
    const current = rule.target === 'negative' ? negative : tag;
    const present = new Set(tagSegments(current).map(segment => segment.toLowerCase()));
    const words = rule.add.filter(word => !present.has(word.toLowerCase()));
    if (!words.length) continue;
    const next = [...tagSegments(current), ...words].join(', ');
    if (rule.target === 'negative') negative = next;
    else tag = next;
    applied.push(`${rule.name}(${hit}): +${words.join(', ')} → ${rule.target === 'negative' ? '负面' : '正面'}`);
  }

  if (!applied.length) return { image, applied };
  return { image: { ...image, tag, negative }, applied };
}

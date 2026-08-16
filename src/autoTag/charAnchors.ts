import { requestCompletion, requestViaMainApi, type ChatMsg } from '@/api/client';
import type { BookRole } from '@/autoTag/bookMemory';
import {
  charTagLib,
  findCharTag,
  upsertCharTag,
  type CharTagEntry,
} from '@/state/charTags';
import { getTagGenChannel } from '@/state/settings';

/**
 * 角色固定外貌 tag 的锚定解析。
 *
 * 每次生成 tag 前:
 * 1. 角色参考里的角色 → 查库;有条目直接锚定,没条目但柏宝书有外貌 → 批量转换一次入库;
 *    库条目依据的外貌原文与柏宝书当前不一致(换发型等) → 重新转换覆盖。
 * 2. 库里有、角色参考里没有、但目标正文提到名字的角色(如用户手动补的 NPC)→ 一并锚定。
 * 锚定结果是一段「必须原样复制」的 tag 列表文本,拼进自动 tag 请求(见 prompt.ts)。
 *
 * 生成失败/无可用条目 → 返回 null,主流程降级为无锚定(保持旧行为),不阻断出图。
 */

export interface AnchorPlan {
  /** 需要(重新)转换的角色:新面孔 + 外貌已变化的 book 条目 */
  toGenerate: Array<{ name: string; desc: string }>;
  /** 本次可锚定的角色名(生成后需按最新库重新取 tags) */
  anchorNames: string[];
}

/**
 * 纯函数:按「角色参考 + 当前库 + 目标正文」算出本轮锚定计划。
 * entries 传调用时的库快照;生成完成后应基于最新库重新调用本函数取最终锚定名单。
 */
export function planCharAnchors(
  roles: BookRole[],
  entries: CharTagEntry[],
  bodyText: string,
): AnchorPlan {
  const byName = new Map(entries.map(e => [e.name, e]));
  const toGenerate: AnchorPlan['toGenerate'] = [];
  const anchorNames: string[] = [];
  const used = new Set<string>();

  for (const role of roles) {
    if (!role.name || used.has(role.name)) continue;
    const entry = byName.get(role.name);
    if (entry) {
      used.add(role.name);
      anchorNames.push(role.name);
      // book 来源且柏宝书外貌变了 → 重新转换(本轮等生成完用新 tag);manual 条目以用户为准,不动
      if (entry.source === 'book' && role.desc && entry.desc !== role.desc) {
        toGenerate.push({ name: role.name, desc: role.desc });
      }
    } else if (role.desc) {
      // 库里没有、柏宝书有外貌 → 转换一次入库,此后锁定
      used.add(role.name);
      toGenerate.push({ name: role.name, desc: role.desc });
    }
    // 库里没有、柏宝书也没记录外貌 → 本轮无锚定,模型自由发挥(用户可在角色管理页手动补)
  }

  // 库里有、角色参考没覆盖、但正文提到名字的(典型:用户手动补的次要 NPC)→ 也锚定
  for (const entry of entries) {
    if (used.has(entry.name)) continue;
    if (bodyText.includes(entry.name)) {
      used.add(entry.name);
      anchorNames.push(entry.name);
    }
  }

  return { toGenerate, anchorNames };
}

/** 把锚定名单拼成提示词文本块(名单为空 → 空串,调用方视为无锚定)。 */
export function buildAnchorText(anchors: CharTagEntry[]): string {
  if (!anchors.length) return '';
  const lines = anchors.map(a => `- ${a.name}: ${a.tags}`);
  return `【角色固定外貌 tag(画面中出现该角色时,对应 tag 串必须原样复制进画面 tag,不得改写、翻译或增删;服装、动作、场景等其余内容仍按正文生成)】\n${lines.join('\n')}`;
}

/* ============ 中文外貌 → 固定 tag 的批量转换 ============ */

const CONVERT_SPEC = `你是外貌 tag 转换器。把给出的角色中文外貌描述转成 danbooru 短 tag:英文小写、逗号分隔、多词用空格连接（不要用下划线）,例如 "long black hair, red eyes, small breasts"。

规则:
1. 只保留固定基础特征:性别(1girl/1boy 等)、发色发型、瞳色、肤色、体型、年龄感、标志性特征(痣/疤/异色瞳/精灵耳等)。
2. 绝不写服装、饰品、状态、表情、动作、场景——这些每次生成时按剧情现场决定。
3. 描述里没提的细节不要脑补,宁可少写。
4. 只返回一个 JSON 对象:{"角色名":"tag 串",...},键与输入的角色名完全一致;不要 Markdown 代码块、不要解释。`;

/** tag 串清洗:换行压成空格、剥 bbi_image 系子标签字面量(防止污染注入格式)。 */
function sanitizeTags(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().replace(/[\r\n]+/g, ' ') : '';
  if (/<\/?(?:bbi_image|tag|nl)\b/i.test(text)) return '';
  return text;
}

/** 从模型回复中解析 {角色名: tag 串}(宽容:带代码块/前后杂质也能解)。 */
export function parseConvertedTags(raw: string): Record<string, string> {
  const cleaned = raw.replace(/<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi, '');
  const candidates: string[] = [cleaned.trim()];
  for (const match of cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.unshift(match[1].trim());
  }
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      const value: unknown = JSON.parse(candidate.slice(start, end + 1));
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const out: Record<string, string> = {};
        for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
          const tags = sanitizeTags(v);
          if (key.trim() && tags) out[key.trim()] = tags;
        }
        return out;
      }
    } catch {
      // 试下一个候选
    }
  }
  return {};
}

/**
 * 批量把中文外貌转成固定 tag。一次请求转换所有待办角色。
 * 渠道与自动 tag 主流程同口径:指派渠道优先,未指派跟随主 API。
 * 返回成功转换的条目;整体失败(请求异常)向上抛,调用方 catch 后降级。
 */
export async function generateCharTags(
  chars: Array<{ name: string; desc: string }>,
  signal?: AbortSignal,
): Promise<Array<{ name: string; desc: string; tags: string }>> {
  if (!chars.length) return [];
  const messages: ChatMsg[] = [
    { role: 'system', content: CONVERT_SPEC },
    {
      role: 'user',
      content: chars.map(c => `- ${c.name}: ${c.desc}`).join('\n'),
    },
  ];
  const channel = getTagGenChannel();
  const raw = channel
    ? await requestCompletion(channel, messages, { signal })
    : await requestViaMainApi(messages, { signal });
  const parsed = parseConvertedTags(raw);
  const out: Array<{ name: string; desc: string; tags: string }> = [];
  for (const c of chars) {
    const tags = parsed[c.name];
    if (tags) out.push({ name: c.name, desc: c.desc, tags });
  }
  return out;
}

/* ============ 主流程入口 ============ */

/**
 * 解析本楼的固定外貌锚定文本。
 * 需要转换的角色一次性批量转换并入库(book 来源,记录所依据的外貌原文);
 * 转换失败不阻断——本轮降级为无锚定/沿用旧条目。
 */
export async function resolveCharAnchors(
  roles: BookRole[],
  bodyText: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const plan = planCharAnchors(roles, charTagLib.entries, bodyText);
  if (!plan.anchorNames.length && !plan.toGenerate.length) return null;

  if (plan.toGenerate.length) {
    try {
      const generated = await generateCharTags(plan.toGenerate, signal);
      for (const g of generated) {
        upsertCharTag({ name: g.name, tags: g.tags, source: 'book', desc: g.desc });
      }
    } catch (error) {
      if (signal?.aborted) return null;
      console.warn('[柏宝绘] 角色固定外貌 tag 转换失败,本轮不做锚定', error);
    }
  }

  // 基于最新库取最终锚定名单(刚生成的条目也在里面了)
  const anchors: CharTagEntry[] = [];
  for (const name of plan.anchorNames) {
    const entry = findCharTag(name);
    if (entry) anchors.push(entry);
  }
  const text = buildAnchorText(anchors);
  return text || null;
}

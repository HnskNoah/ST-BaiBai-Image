import { requestCompletion, requestViaMainApi, type ChatMsg } from '@/api/client';
import type { BookRole } from '@/autoTag/bookMemory';
import {
  CHAR_TAG_FIELD_LABELS,
  CHAR_TAG_FIELDS,
  applyCharTagOps,
  createCharTagNewOp,
  emptyCharFields,
  type CharTagAutoOp,
  type CharTagEntry,
  type CharTagField,
} from '@/state/charTags';
import { getTagGenChannel } from '@/state/settings';

/**
 * 角色固定外貌库的「锚定」侧。
 *
 * 生成 tag 前:
 * 1. 柏宝书角色参考里有外貌、库里还没有该角色 → 转换成当前楼层的建档操作;
 *    写回成功后才随消息 extra 落盘,楼层删除时自然消失。
 * 2. 库文本(全部条目)拼进请求:AI 看得到每个角色当前的字段值,才能判断需不需要改;
 *    但画面 tag 里它只写 @角色名 占位符,不抄外貌 —— 替换由插件机械完成,杜绝复述漂移。
 *
 * 主流程顺序:先落 changes(本楼发生的变化当楼生效) → 再用最新库替换 @占位符。
 */

/** 把库条目渲染成给 AI 看的一行(字段式明细 + 占位符提示)。 */
export function formatEntryForPrompt(entry: CharTagEntry): string {
  const parts: string[] = [];
  for (const f of CHAR_TAG_FIELDS) {
    const v = entry.fields[f]?.trim();
    if (v) parts.push(`${CHAR_TAG_FIELD_LABELS[f]}=${v}`);
  }
  if (!parts.length && entry.raw.trim()) parts.push(`tag=${entry.raw.trim()}`);
  return `- ${entry.name}: ${parts.join(', ') || '(未记录字段)'}`;
}

/**
 * 库文本:发给 AI 的角色库部分。AI 依据它决定 changes 与 @引用;
 * 名单与字段值都由插件生成,AI 只读。
 */
export function buildLibraryText(entries: CharTagEntry[]): string {
  if (!entries.length) return '';
  const lines = entries.map(formatEntryForPrompt);
  return `【角色固定外貌库(系统维护;画面 tag 中用 @角色名 引用,外貌由系统替换)】\n${lines.join('\n')}`;
}

/** 旧接口兼容:runner 之外仍有调用方依赖锚定文本形态。 */
export function buildAnchorText(entries: CharTagEntry[]): string {
  return buildLibraryText(entries);
}

/* ============ 中文外貌 → 结构化字段 的批量转换 ============ */

const CONVERT_SPEC = `你是外貌 tag 转换器。把给出的角色中文外貌描述拆成固定字段的 danbooru 短 tag:英文小写、逗号分隔、多词用空格连接(不要用下划线)。

字段与示例:
- sex(性别):1girl / 1boy / androgynous 等
- hair(头发):long black hair / short silver hair 等
- eyes(眼睛):red eyes / blue eyes 等
- skin(肤色):pale skin / tan 等(没提就留空)
- body(体型):petite / tall / slim / small breasts 等
- extra(标志特征):heterochromia / scar on cheek / pointy ears 等(没提就留空)

规则:
1. 只提取固定基础特征;服装、饰品、状态、表情、动作、场景一律不写。
2. hair 与 eyes 是二次元角色身份锚点：描述里只要出现发色、发型/长度或瞳色线索就必须写入对应字段，不得遗漏或塞进 extra；hair 尽量同时保留颜色和长度/发型，eyes 保留颜色。
3. 描述里没提的细节不要脑补,对应字段留空字符串。
4. 只返回一个 JSON 对象:{"角色名":{"sex":"...","hair":"...","eyes":"...","skin":"...","body":"...","extra":"..."}},键与输入的角色名完全一致;不要 Markdown 代码块、不要解释。`;

/** 字段值清洗:换行压成空格、剥 bbi_image 系子标签字面量(防止污染注入格式)。 */
function sanitizeTagValue(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().replace(/[\r\n]+/g, ' ') : '';
  if (!text) return '';
  if (/<\/?(?:bbi_image|tag|nl|size)\b/i.test(text)) return '';
  return text;
}

/** 从模型回复中解析 {角色名: {字段: tag}}(宽容:带代码块/前后杂质也能解)。 */
export function parseConvertedTags(raw: string): Record<string, Partial<Record<CharTagField, string>>> {
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
        const out: Record<string, Partial<Record<CharTagField, string>>> = {};
        for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
          const name = key.trim();
          if (!name || !v || typeof v !== 'object' || Array.isArray(v)) continue;
          const fields: Partial<Record<CharTagField, string>> = {};
          for (const f of CHAR_TAG_FIELDS) {
            const tag = sanitizeTagValue((v as Record<string, unknown>)[f]);
            if (tag) fields[f] = tag;
          }
          if (Object.keys(fields).length) out[name] = fields;
        }
        return out;
      }
    } catch {
      // 试下一个候选
    }
  }
  return {};
}

export interface ConvertedChar {
  name: string;
  desc: string;
  fields: Partial<Record<CharTagField, string>>;
}

/**
 * 批量把中文外貌转成结构化字段。一次请求转换所有待办角色。
 * 渠道与自动 tag 主流程同口径:指派渠道优先,未指派跟随主 API。
 * 返回成功转换的条目;整体失败(请求异常)向上抛,调用方 catch 后降级。
 */
export async function generateCharTags(
  chars: Array<{ name: string; desc: string }>,
  signal?: AbortSignal,
): Promise<ConvertedChar[]> {
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
  const out: ConvertedChar[] = [];
  for (const c of chars) {
    const fields = parsed[c.name];
    if (fields) out.push({ name: c.name, desc: c.desc, fields });
  }
  return out;
}

/* ============ 主流程入口 ============ */

/**
 * 生成前的库准备:柏宝书角色参考里有外貌、库里没有的角色 → 批量转换入库(book 来源)。
 * 已有条目一律不动(AI 维护;手动条目更不动)。失败不阻断 —— 本轮该角色无锚定,模型自由发挥。
 * 返回库文本(拼进请求);空库返回 ''。
 */
export interface ResolvedCharAnchors {
  text: string | null;
  entries: CharTagEntry[];
  ops: CharTagAutoOp[];
}

export async function resolveCharAnchors(
  roles: BookRole[],
  entriesBefore: CharTagEntry[],
  signal?: AbortSignal,
): Promise<ResolvedCharAnchors> {
  // 只给「库中没有」的角色建档;已有条目(无论来源)都不被柏宝书覆盖
  const known = new Set(entriesBefore.map(entry => entry.name));
  const toGenerate = roles.filter(r => r.name && r.desc && !known.has(r.name));
  const ops: CharTagAutoOp[] = [];
  if (toGenerate.length) {
    try {
      const generated = await generateCharTags(toGenerate, signal);
      for (const g of generated) {
        const fields = emptyCharFields();
        for (const f of CHAR_TAG_FIELDS) {
          const v = g.fields[f];
          if (v) fields[f] = v;
        }
        const op = createCharTagNewOp({
          name: g.name,
          fields,
          raw: '',
          nl: '',
          source: 'book',
          desc: g.desc,
        }, '柏宝书建档');
        if (op) ops.push(op);
      }
    } catch (error) {
      if (signal?.aborted) return { text: null, entries: entriesBefore, ops: [] };
      console.warn('[柏宝绘] 角色固定外貌 tag 转换失败,本轮不做锚定', error);
    }
  }
  const entries = applyCharTagOps(entriesBefore, ops, -1);
  const text = buildLibraryText(entries);
  return { text: text || null, entries, ops };
}

/* ============ @占位符 替换 ============ */

/** @名 占位符;名字允许中文/字母/数字/点/下划线/间隔号(常见角色名形态)。 */
const REF_PATTERN = /@([\p{L}\p{N}_.·]+)/gu;

function joinEntryTag(entry: CharTagEntry): string {
  // 与 state/charTags.buildEntryTag 同构;重复这一小段以避开循环依赖
  if (entry.raw.trim() && CHAR_TAG_FIELDS.every(f => !(entry.fields[f] ?? '').trim())) {
    return entry.raw.trim();
  }
  return CHAR_TAG_FIELDS.map(f => (entry.fields[f] ?? '').trim())
    .filter(Boolean)
    .join(', ');
}

/** 压缩替换后残留的分隔符垃圾:连续逗号、行首行尾逗号。 */
function tidySeparators(text: string): string {
  let out = text;
  for (let i = 0; i < 4; i += 1) {
    const next = out.replace(/,\s*,/g, ',').replace(/\s+,/g, ',').replace(/,\s+/g, ', ');
    if (next === out) break;
    out = next;
  }
  return out.replace(/^[\s,]+/, '').replace(/[\s,]+$/, '').trim();
}

/**
 * AI 输出文本里的 @占位符 处理:库里有的 → 替换成最新 tag 串(nl 模式优先条目的自然语言句);
 * 没有的 → 剥掉(连带尾随分隔符)。返回处理后的文本与未知名字列表(调用方可用于告警)。
 */
export function applyCharRefs(
  text: string,
  entries: CharTagEntry[],
  mode: 'tag' | 'nl' = 'tag',
): { text: string; unknown: string[] } {
  const byName = new Map(entries.map(e => [e.name, e]));
  const unknown: string[] = [];
  const seen = new Set<string>();
  const replaced = text.replace(REF_PATTERN, (_full, name: string) => {
    const entry = byName.get(name);
    if (entry) {
      if (mode === 'nl' && entry.nl.trim()) return entry.nl.trim();
      return joinEntryTag(entry);
    }
    if (!seen.has(name)) {
      seen.add(name);
      unknown.push(name);
    }
    return '';
  });
  return { text: tidySeparators(replaced), unknown };
}

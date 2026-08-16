import { getContext } from '@/st/context';
import { reactive } from 'vue';

/**
 * 角色固定外貌库 —— **仅当前聊天生效**,存进 ST 的 chatMetadata(随聊天存档走,不跨聊天)。
 *
 * v2 结构化:外貌按固定字段(sex/hair/eyes/skin/body/extra/outfit)记录,
 * 最终 tag 串由 buildEntryTag 按固定顺序拼出,不依赖模型/用户的书写习惯;
 * 旧版整串数据以 raw 模式兼容(raw 非空且 fields 全空时生效)。
 *
 * 维护权归生成 tag 的 AI:它通过输出协议的 changes 报告持久变化,插件直接落库并记历史,
 * 不询问用户;柏宝书只负责「出生」——首次建档时可从其外貌记录转换入库,
 * 此后条目归 AI 维护,柏宝书外貌再变也不自动覆盖。
 * 服装、临时状态等会变动的内容不入库(「固定着装」字段除外),仍由模型按正文现场生成。
 */

export type CharTagField = 'sex' | 'hair' | 'eyes' | 'skin' | 'body' | 'extra' | 'outfit';

/** 字段拼接顺序 = 重要度顺序;库文本/界面都按它展示。 */
export const CHAR_TAG_FIELDS: readonly CharTagField[] = [
  'sex',
  'hair',
  'eyes',
  'skin',
  'body',
  'extra',
  'outfit',
];

export const CHAR_TAG_FIELD_LABELS: Record<CharTagField, string> = {
  sex: '性别',
  hair: '头发',
  eyes: '眼睛',
  skin: '肤色',
  body: '体型',
  extra: '标志特征',
  outfit: '固定着装',
};

export type CharTagSource = 'book' | 'manual' | 'ai';

/** 历史记录可指向的字段:'new' = 建档、'raw' = 整串更新、'nl' = 自然语言句更新。 */
export type CharTagHistoryField = CharTagField | 'new' | 'raw' | 'nl';

/** 条目的一次变更记录(时间升序,最新在后;上限 50 条)。 */
export interface CharTagChangeRecord {
  field: CharTagHistoryField;
  from: string;
  to: string;
  reason: string;
  /** 变更来源楼层;手动编辑/回滚为 -1。 */
  floor: number;
  /** 时间戳(ms)。 */
  at: number;
}

export interface CharTagEntry {
  /** 角色名,与柏宝书 npc.name / 正文称呼一致;也是 @占位符 的匹配键。 */
  name: string;
  /** 结构化固定外貌字段(空串 = 未记录)。 */
  fields: Record<CharTagField, string>;
  /** 整串模式(旧版数据/手写整串);非空且 fields 全空时拼接生效。 */
  raw: string;
  /** 一句连贯英文外貌描述(自然语言模式的 @占位符替换内容;可空)。 */
  nl: string;
  /** 条目来源:book = 柏宝书转换;manual = 手建;ai = AI 变更/建档接管后。 */
  source: CharTagSource;
  /** 建档依据的柏宝书外貌原文(仅 book 来源用于变化比对;AI 接管或手改后清空)。 */
  desc: string;
  history: CharTagChangeRecord[];
}

/** chatMetadata 里的存储键与结构(带版本号,便于以后迁移) */
const META_KEY = 'baibai_image_char_tags';
const HISTORY_CAP = 50;

interface CharTagStore {
  version: 2;
  entries: CharTagEntry[];
}

/** 当前聊天的条目列表(reactive,页面直接绑定)。切换聊天时由 hydrateCharTags 整体替换。 */
export const charTagLib = reactive<{ entries: CharTagEntry[] }>({ entries: [] });

/* ============ 纯工具 ============ */

export function emptyCharFields(): Record<CharTagField, string> {
  return { sex: '', hair: '', eyes: '', skin: '', body: '', extra: '', outfit: '' };
}

export function charFieldsEmpty(fields: Record<CharTagField, string>): boolean {
  return CHAR_TAG_FIELDS.every(f => !(fields[f] ?? '').trim());
}

/** 条目最终 tag 串:整串模式(raw 且无字段)用 raw;否则按固定顺序拼接非空字段。 */
export function buildEntryTag(entry: Pick<CharTagEntry, 'fields' | 'raw'>): string {
  if (entry.raw.trim() && charFieldsEmpty(entry.fields)) return entry.raw.trim();
  return CHAR_TAG_FIELDS.map(f => (entry.fields[f] ?? '').trim())
    .filter(Boolean)
    .join(', ');
}

function isHistoryField(value: string): value is CharTagHistoryField {
  return (CHAR_TAG_FIELDS as readonly string[]).includes(value) || value === 'new' || value === 'raw' || value === 'nl';
}

function normalizeHistory(raw: unknown): CharTagChangeRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: CharTagChangeRecord[] = [];
  for (const item of raw.slice(-HISTORY_CAP)) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Partial<CharTagChangeRecord>;
    const field = typeof o.field === 'string' ? o.field : '';
    if (!isHistoryField(field)) continue;
    out.push({
      field,
      from: typeof o.from === 'string' ? o.from : '',
      to: typeof o.to === 'string' ? o.to : '',
      reason: typeof o.reason === 'string' ? o.reason : '',
      floor: typeof o.floor === 'number' && Number.isFinite(o.floor) ? o.floor : -1,
      at: typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0,
    });
  }
  return out;
}

function normalizeEntry(raw: unknown): CharTagEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Partial<CharTagEntry> & { tags?: unknown };
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (!name) return null;
  const fields = emptyCharFields();
  if (o.fields && typeof o.fields === 'object' && !Array.isArray(o.fields)) {
    for (const f of CHAR_TAG_FIELDS) {
      const v = (o.fields as Record<string, unknown>)[f];
      if (typeof v === 'string') fields[f] = v.trim();
    }
  }
  // 旧版(v1)整串字段 tags → raw 模式兼容
  const legacyTags = typeof o.tags === 'string' ? o.tags.trim() : '';
  const rawStr = typeof o.raw === 'string' ? o.raw.trim() : legacyTags;
  const nl = typeof o.nl === 'string' ? o.nl.trim() : '';
  // 全空条目没有可用外貌,丢弃
  if (!rawStr && charFieldsEmpty(fields)) return null;
  const source: CharTagSource =
    o.source === 'book' || o.source === 'ai' ? o.source : 'manual';
  return {
    name,
    fields,
    raw: rawStr,
    nl,
    source,
    desc: typeof o.desc === 'string' ? o.desc : '',
    history: normalizeHistory(o.history),
  };
}

/** 容错解析任意来源的库存储(手改坏/旧版本数据 → 尽量救,救不了丢弃该条)。 */
export function normalizeCharTagStore(raw: unknown): CharTagEntry[] {
  if (!raw || typeof raw !== 'object') return [];
  const entries = (raw as Partial<CharTagStore>).entries;
  if (!Array.isArray(entries)) return [];
  const out: CharTagEntry[] = [];
  const seen = new Set<string>();
  for (const item of entries) {
    const entry = normalizeEntry(item);
    // 同名去重:保留先出现的(正常数据不会重名,防御手改)
    if (entry && !seen.has(entry.name)) {
      seen.add(entry.name);
      out.push(entry);
    }
  }
  return out;
}

/**
 * 从当前聊天的 chatMetadata 载入库。无聊天/无数据 → 空库。
 * 切换聊天(CHAT_CHANGED)与插件启动时各调一次。
 */
export function hydrateCharTags(): void {
  const ctx = getContext();
  const raw = ctx?.chatMetadata?.[META_KEY];
  charTagLib.entries = normalizeCharTagStore(raw);
}

/** 写回 chatMetadata 并防抖落盘(随聊天保存)。无上下文时静默丢弃。 */
function persist(): void {
  const ctx = getContext();
  if (!ctx?.chatMetadata) return;
  const store: CharTagStore = {
    version: 2,
    entries: JSON.parse(JSON.stringify(charTagLib.entries)) as CharTagEntry[],
  };
  ctx.chatMetadata[META_KEY] = store;
  ctx.saveMetadataDebounced?.();
}

/** 按名字查条目(精确匹配;调用方负责保证 name 已 trim)。 */
export function findCharTag(name: string): CharTagEntry | undefined {
  return charTagLib.entries.find(e => e.name === name);
}

function pushHistory(entry: CharTagEntry, record: CharTagChangeRecord): void {
  entry.history.push(record);
  if (entry.history.length > HISTORY_CAP) {
    entry.history.splice(0, entry.history.length - HISTORY_CAP);
  }
}

export interface UpsertOptions {
  /** 覆盖已有条目时,把字段差异记进历史(reason 固定「手动编辑」)。 */
  recordChanges?: boolean;
}

/**
 * 新增或覆盖条目(按 name 定位)。name 或拼接结果为空则忽略并返回 false。
 * 改名场景:传 oldName 先删旧条目(oldName 与 name 不同才删)。
 * 传入 history 为空时沿用库中已有条目的历史(recordChanges 时再追加差异记录)。
 */
export function upsertCharTag(
  entry: CharTagEntry,
  oldName?: string,
  opts: UpsertOptions = {},
): boolean {
  const name = entry.name.trim();
  if (!name || !buildEntryTag(entry)) return false;
  if (oldName && oldName !== name) {
    const oldIdx = charTagLib.entries.findIndex(e => e.name === oldName);
    if (oldIdx >= 0) charTagLib.entries.splice(oldIdx, 1);
  }
  const idx = charTagLib.entries.findIndex(e => e.name === name);
  const prev = idx >= 0 ? charTagLib.entries[idx] : null;
  const next: CharTagEntry = {
    name,
    fields: emptyCharFields(),
    raw: entry.raw.trim(),
    nl: entry.nl.trim(),
    source: entry.source,
    desc: entry.desc,
    history: entry.history.length ? entry.history : (prev?.history ?? []),
  };
  for (const f of CHAR_TAG_FIELDS) next.fields[f] = (entry.fields[f] ?? '').trim();
  if (opts.recordChanges && prev) {
    const at = Date.now();
    for (const f of CHAR_TAG_FIELDS) {
      if (prev.fields[f] !== next.fields[f]) {
        pushHistory(next, { field: f, from: prev.fields[f], to: next.fields[f], reason: '手动编辑', floor: -1, at });
      }
    }
    if (prev.raw !== next.raw && (prev.raw || next.raw)) {
      pushHistory(next, { field: 'raw', from: prev.raw, to: next.raw, reason: '手动编辑', floor: -1, at });
    }
    if (prev.nl !== next.nl && (prev.nl || next.nl)) {
      pushHistory(next, { field: 'nl', from: prev.nl, to: next.nl, reason: '手动编辑', floor: -1, at });
    }
  }
  if (idx >= 0) charTagLib.entries[idx] = next;
  else charTagLib.entries.push(next);
  persist();
  return true;
}

/** 删除条目;不存在则返回 false。 */
export function removeCharTag(name: string): boolean {
  const idx = charTagLib.entries.findIndex(e => e.name === name);
  if (idx < 0) return false;
  charTagLib.entries.splice(idx, 1);
  persist();
  return true;
}

/* ============ AI 变更落库 ============ */

/** AI 建档请求的宽松形状(protocol.ts 解析产物的一部分)。 */
export interface AiEntryInput {
  name: string;
  /** 结构化字段(部分给出即可)。 */
  fields?: Partial<Record<CharTagField, string>>;
  /** 没给 fields 时的整串 fallback。 */
  value?: string;
  nl?: string;
  reason?: string;
}

/**
 * AI 新建条目(field=new)。同名条目已存在时拒绝(调用方应改走字段合并)。
 * fields 与 value 都拿不出内容 → 拒绝。
 */
export function createAiEntry(change: AiEntryInput, floor: number): boolean {
  const name = change.name.trim();
  if (!name || findCharTag(name)) return false;
  const fields = emptyCharFields();
  let hasFields = false;
  if (change.fields) {
    for (const f of CHAR_TAG_FIELDS) {
      const v = change.fields[f]?.trim();
      if (v) {
        fields[f] = v;
        hasFields = true;
      }
    }
  }
  const raw = hasFields ? '' : (change.value ?? '').trim();
  const nl = (change.nl ?? '').trim();
  if (!hasFields && !raw) return false;
  const entry: CharTagEntry = {
    name,
    fields,
    raw,
    nl,
    source: 'ai',
    desc: '',
    history: [],
  };
  pushHistory(entry, {
    field: 'new',
    from: '',
    to: buildEntryTag(entry),
    reason: change.reason ?? '',
    floor,
    at: Date.now(),
  });
  charTagLib.entries.push(entry);
  persist();
  return true;
}

/**
 * AI 单字段变更落库(记录历史)。条目不存在 / 新值为空 / 与当前值相同 → 跳过返回 false。
 * 字段式更新落在整串模式条目上没有可见效果(拼接优先 raw)→ 跳过并告警,防脏数据。
 * 任何成功变更都把条目接管为 ai 来源(柏宝书此后不再自动重转)。
 */
export function applyAiChange(
  name: string,
  field: CharTagField | 'raw' | 'nl',
  value: string,
  reason: string,
  floor: number,
): boolean {
  const entry = findCharTag(name.trim());
  if (!entry) return false;
  const next = value.trim();
  if (!next) return false;
  const current = field === 'raw' ? entry.raw : field === 'nl' ? entry.nl : entry.fields[field];
  if (current === next) return false;
  if (field !== 'raw' && field !== 'nl' && entry.raw.trim() && charFieldsEmpty(entry.fields)) {
    console.warn(`[柏宝绘] 角色「${entry.name}」是整串模式,AI 的 ${field} 字段变更被忽略(应更新 raw)`);
    return false;
  }
  if (field === 'raw') entry.raw = next;
  else if (field === 'nl') entry.nl = next;
  else entry.fields[field] = next;
  entry.source = 'ai';
  entry.desc = '';
  pushHistory(entry, { field, from: current, to: next, reason, floor, at: Date.now() });
  persist();
  return true;
}

/** 回滚一条历史记录:字段回到 from;建档记录的回滚 = 删除条目。回滚动作本身也入历史。 */
export function rollbackCharTag(name: string, record: CharTagChangeRecord): boolean {
  const entry = findCharTag(name);
  if (!entry) return false;
  if (record.field === 'new') return removeCharTag(name);
  if (record.field === 'raw') entry.raw = record.from;
  else if (record.field === 'nl') entry.nl = record.from;
  else entry.fields[record.field] = record.from;
  pushHistory(entry, { field: record.field, from: record.to, to: record.from, reason: '手动回滚', floor: -1, at: Date.now() });
  persist();
  return true;
}

let bound = false;

/** 绑定聊天切换重载 + 启动时首次载入。可安全重复调用。 */
export function bindCharTagSync(): void {
  if (bound) return;
  const ctx = getContext();
  if (!ctx?.eventSource || !ctx.eventTypes?.CHAT_CHANGED) return;
  bound = true;
  ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => hydrateCharTags());
  hydrateCharTags();
}

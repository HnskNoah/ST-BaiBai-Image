import { getContext } from '@/st/context';
import { reactive } from 'vue';

/**
 * 角色固定外貌 tag 库 —— **仅当前聊天生效**,存进 ST 的 chatMetadata(随聊天存档走,不跨聊天)。
 *
 * 解决两个问题:
 * 1. 柏宝书不是每个角色都记录了外貌(次要 NPC 可能没有)——库里可以手动补一条;
 * 2. 即使有记录,每次生成 tag 都重新翻译/改写外貌,会产生偏移——
 *    首次把中文外貌转成英文 tag 后入库,之后生成时原样锚定,不再即兴发挥。
 *
 * 只记录固定基础特征(发色/瞳色/体型等);服装、状态等会变动的东西不入库,
 * 仍由模型按正文现场生成。
 */

export interface CharTagEntry {
  /** 角色名,与柏宝书 npc.name / 主角名一致,作为匹配键 */
  name: string;
  /** 固定基础外貌 tag(英文 danbooru tag 串) */
  tags: string;
  /** 来源:book = 从柏宝书外貌自动转换;manual = 用户手填/手改 */
  source: 'book' | 'manual';
  /** source 为 book 时:生成所依据的柏宝书外貌原文,用于检测外貌变化;manual 为空串 */
  desc: string;
}

/** chatMetadata 里的存储键与结构(带版本号,便于以后迁移) */
const META_KEY = 'baibai_image_char_tags';

interface CharTagStore {
  version: 1;
  entries: CharTagEntry[];
}

/** 当前聊天的条目列表(reactive,页面直接绑定)。切换聊天时由 hydrateCharTags 整体替换。 */
export const charTagLib = reactive<{ entries: CharTagEntry[] }>({ entries: [] });

function normalizeEntry(raw: unknown): CharTagEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Partial<CharTagEntry>;
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  const tags = typeof o.tags === 'string' ? o.tags.trim() : '';
  if (!name || !tags) return null;
  return {
    name,
    tags,
    source: o.source === 'book' ? 'book' : 'manual',
    desc: typeof o.desc === 'string' ? o.desc : '',
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
    version: 1,
    entries: JSON.parse(JSON.stringify(charTagLib.entries)) as CharTagEntry[],
  };
  ctx.chatMetadata[META_KEY] = store;
  ctx.saveMetadataDebounced?.();
}

/** 按名字查条目(精确匹配;调用方负责保证 name 已 trim)。 */
export function findCharTag(name: string): CharTagEntry | undefined {
  return charTagLib.entries.find(e => e.name === name);
}

/**
 * 新增或覆盖条目(按 name 定位)。name/tags 任一空则忽略并返回 false。
 * 改名场景:传 oldName 先删旧条目(oldName 与 name 不同才删)。
 */
export function upsertCharTag(entry: CharTagEntry, oldName?: string): boolean {
  const name = entry.name.trim();
  const tags = entry.tags.trim();
  if (!name || !tags) return false;
  if (oldName && oldName !== name) {
    const oldIdx = charTagLib.entries.findIndex(e => e.name === oldName);
    if (oldIdx >= 0) charTagLib.entries.splice(oldIdx, 1);
  }
  const idx = charTagLib.entries.findIndex(e => e.name === name);
  const next: CharTagEntry = { name, tags, source: entry.source, desc: entry.desc };
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

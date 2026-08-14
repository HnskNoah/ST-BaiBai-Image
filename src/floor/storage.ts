import type { ComfyImageResult } from '@/backends/comfyui';
import { deleteImageFile, uploadImageFile } from '@/floor/upload';
import { getContext, type STContext, type STMessage } from '@/st/context';

/**
 * 楼层卡片结果存储层（DESIGN-FLOOR-UI.md §7）。
 *
 * 两层分离：
 * - 图片二进制 → ST 文件系统（user/files/bbi_...png），extra 只存指针 path。
 * - 元数据 → message.extra.bbiImage = { [swipeId]: { [promptHash]: BbiImageEntry[] } }
 *   按 swipeId 分桶（滑动互不污染）；promptHash 键下是历史列表（时间正序，
 *   最新在末尾，卡片翻页浏览）；水合时用当前 tag 原文重算 hash 做 stale 检测。
 *
 * 命名平铺（实测修正：validateAssetFileName 只允许 [a-zA-Z0-9_.-]，拒绝斜杠子目录）：
 *   bbi_<chatId>_<swipeId>_<promptHash>-<generationId>.<ext>
 */

export interface BbiImageEntry {
  /** 本次生成唯一 id。 */
  generationId: string;
  /** ST 静态路径 /user/files/...（<img src> 直接引用）。 */
  path: string;
  /** 生成时使用的完整 tag 原文（含 <bbi_image> 壳），与 promptHash 输入一致。 */
  prompt: string;
  /** 本次生成种子；第四步种子策略落地前固定 null。 */
  seed: number | null;
  status: 'ready' | 'error';
  createdAt: number;
  /** 生成时所在槽位序号（楼层内第 N 个 tag）。多 tag 楼层按位置隔离结果；
   *  旧数据缺失时按 entrySeq() 回退为 0。 */
  slotSeq?: number;
}

/** [swipeId][promptHash] = 历史 entry 列表。 */
export type BbiImageStore = Record<string, Record<string, BbiImageEntry[]>>;

export const BBI_IMAGE_EXTRA_KEY = 'bbiImage';

/* —— hash 与命名 —— */

/** cyrb53 派生：同步、确定、对聊天级提示词足够分散；输出 14 位 hex。 */
export function promptHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

export function generationId(): string {
  return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 平铺文件名：chatId 中的非法字符（非字母数字 _ -）替换为 _。 */
export function imageFileName(
  chatId: string,
  swipeId: number,
  hash: string,
  genId: string,
  ext: string,
): string {
  const safeChatId = chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `bbi_${safeChatId}_${swipeId}_${hash}-${genId}.${ext}`;
}

/* —— extra 读写（纯函数） —— */

export function readStore(message: STMessage): BbiImageStore | null {
  const extra = message.extra;
  if (!extra || typeof extra[BBI_IMAGE_EXTRA_KEY] !== 'object' || extra[BBI_IMAGE_EXTRA_KEY] === null) {
    return null;
  }
  return extra[BBI_IMAGE_EXTRA_KEY] as BbiImageStore;
}

/** hash 匹配的最新一条结果（卡片 ready）。 */
/** 旧数据（无 slotSeq 字段）回退为槽位 0。 */
function entrySeq(entry: BbiImageEntry): number {
  return entry.slotSeq ?? 0;
}

/** 同槽位的全部历史（时间正序，最新在末尾）。卡片翻页用。 */
export function historyEntries(
  store: BbiImageStore | null,
  swipeId: number,
  hash: string,
  seq: number,
): BbiImageEntry[] {
  const list = store?.[String(swipeId)]?.[hash];
  if (!list) return [];
  return list.filter(entry => entrySeq(entry) === seq);
}

/** hash 匹配且位于同一槽位的最新一条结果（卡片 ready）。 */
export function latestEntry(
  store: BbiImageStore | null,
  swipeId: number,
  hash: string,
  seq: number,
): BbiImageEntry | null {
  const list = store?.[String(swipeId)]?.[hash];
  if (!list || list.length === 0) return null;
  for (let i = list.length - 1; i >= 0; i--) {
    if (entrySeq(list[i]) === seq) return list[i];
  }
  return null;
}

/** 当前 hash 无该槽位结果时，其它提示词（stale）在同一槽位的最新一条（卡片 stale）。
 *  只取同槽位：相邻 tag 的结果不会被误当成这个 tag 的历史。 */
export function latestStaleEntry(
  store: BbiImageStore | null,
  swipeId: number,
  hash: string,
  seq: number,
): BbiImageEntry | null {
  const bucket = store?.[String(swipeId)];
  if (!bucket) return null;
  let latest: BbiImageEntry | null = null;
  for (const [key, list] of Object.entries(bucket)) {
    if (key === hash || list.length === 0) continue;
    for (let i = list.length - 1; i >= 0; i--) {
      if (entrySeq(list[i]) !== seq) continue;
      const candidate = list[i];
      if (!latest || candidate.createdAt > latest.createdAt) latest = candidate;
      break; // 该桶内最新的一条即可
    }
  }
  return latest;
}

/** 不可变式追加一条历史（返回新 store，原 store 不动）。 */
export function appendEntry(
  store: BbiImageStore,
  swipeId: number,
  hash: string,
  entry: BbiImageEntry,
): BbiImageStore {
  const swipeKey = String(swipeId);
  const next: BbiImageStore = { ...store };
  next[swipeKey] = { ...(store[swipeKey] ?? {}) };
  next[swipeKey][hash] = [...(store[swipeKey]?.[hash] ?? []), entry];
  return next;
}

/* —— CAS 写回 —— */

/**
 * 读-改-写循环：mutate 基于当前 store 返回新 store，写回前校验引用未被
 * 并发写入替换，冲突则基于最新 store 重试（DESIGN-FLOOR-UI.md §7.2）。
 */
export async function mutateStore(
  ctx: STContext,
  messageId: number,
  mutate: (store: BbiImageStore) => BbiImageStore,
): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const message = ctx.chat[messageId];
    if (!message) return false;
    if (!message.extra) message.extra = {};
    let store = message.extra[BBI_IMAGE_EXTRA_KEY] as BbiImageStore | undefined;
    if (!store) {
      // 首次建立：同步写回空对象确立引用（无 await，无竞态窗口）
      message.extra[BBI_IMAGE_EXTRA_KEY] = {};
      store = message.extra[BBI_IMAGE_EXTRA_KEY] as BbiImageStore;
    }
    const next = mutate(store);
    if (message.extra[BBI_IMAGE_EXTRA_KEY] !== store) continue; // 并发写入，重试
    message.extra[BBI_IMAGE_EXTRA_KEY] = next;
    await ctx.saveChat();
    return true;
  }
  console.warn('[柏宝绘] extra 写入重试耗尽，放弃本次写入');
  return false;
}

/* —— 保存流程 —— */

async function resultToBase64(result: ComfyImageResult): Promise<string> {
  if (result.url.startsWith('data:')) {
    // server 代理模式：data URL 去前缀直接用
    const comma = result.url.indexOf(',');
    return result.url.slice(comma + 1);
  }
  // browser 直连模式：blob URL → blob → base64（分块拼接防栈溢出）
  const response = await fetch(result.url);
  if (!response.ok) throw new Error(`读取图片失败 (${response.status})`);
  const blob = await response.blob();
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * 完整保存流程（DESIGN-FLOOR-UI.md §7.6）：
 * 图片二进制落盘 → extra 写指针（先文件后指针，避免孤儿指针）；
 * 指针写失败则文件留作孤儿，由后续清理兜底。
 */
export async function saveImageResult(
  messageId: number,
  swipeId: number,
  seq: number,
  tag: string,
  seed: number,
  result: ComfyImageResult,
): Promise<BbiImageEntry> {
  const ctx = getContext();
  if (!ctx?.saveChat) throw new Error('SillyTavern 上下文不可用');
  const chatId = ctx.getCurrentChatId();
  if (!chatId) throw new Error('当前聊天不可用');

  const hash = promptHash(tag);
  const genId = generationId();
  const name = imageFileName(chatId, swipeId, hash, genId, result.format);
  const base64 = await resultToBase64(result);
  const path = await uploadImageFile(name, base64);

  const entry: BbiImageEntry = {
    generationId: genId,
    path,
    prompt: tag,
    // 本次生成实际使用的种子（调用方生成后传入；-1 不在支持范围）
    seed,
    status: 'ready',
    createdAt: Date.now(),
    slotSeq: seq,
  };
  const saved = await mutateStore(ctx, messageId, store => appendEntry(store, swipeId, hash, entry));
  if (!saved) {
    console.warn('[柏宝绘] 图片已上传但 extra 写入失败，文件留作孤儿', path);
    throw new Error('图片已上传，但聊天记录保存失败');
  }
  return entry;
}

/**
 * 删除一条结果：先 extra 删指针并落盘，成功后再删文件（顺序相反会留下
 * 指向已删文件的破指针；文件删除失败则留作孤儿由清理兜底）。
 */
export async function deleteImageResult(
  messageId: number,
  swipeId: number,
  hash: string,
  genId: string,
): Promise<boolean> {
  const ctx = getContext();
  if (!ctx?.saveChat) return false;
  let pathToDelete = '';
  const removed = await mutateStore(ctx, messageId, store => {
    const bucket = store[String(swipeId)];
    const list = bucket?.[hash];
    if (!list) return store;
    const index = list.findIndex(entry => entry.generationId === genId);
    if (index < 0) return store;
    pathToDelete = list[index].path;
    const nextList = list.filter((_, i) => i !== index);
    const next: BbiImageStore = { ...store };
    next[String(swipeId)] = { ...bucket };
    if (nextList.length) {
      next[String(swipeId)][hash] = nextList;
    } else {
      delete next[String(swipeId)][hash];
    }
    return next;
  });
  if (!removed) return false;
  if (pathToDelete) {
    try {
      await deleteImageFile(pathToDelete);
    } catch (error) {
      console.warn('[柏宝绘] 删除图片文件失败（留作孤儿）', error);
    }
  }
  return true;
}

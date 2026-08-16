/**
 * 「写入 tag 后自动生成图片」握手(autoTag.autoGenerate,默认开)。
 *
 * 时序:runner 写入 tag 前为每个新槽位挂上标记 → applyMessageText 内部触发
 * MESSAGE_EDITED / MESSAGE_UPDATED → 楼层重渲染、卡片水合挂载 →
 * 卡片 onMounted 消费本槽位标记并自动开始生成。
 *
 * 标记一次性:消费即删,重水合不会重复触发;楼层懒渲染(群聊等)时标记暂存,
 * 等楼层真正渲染再消费;切聊天/删楼时整体清空,避免污染其它聊天或旧槽位。
 */

const flags = new Set<string>();

function key(chatId: string, messageId: number, swipeId: number, seq: number): string {
  return `${chatId}|${messageId}|${swipeId}|${seq}`;
}

export function markForAutoGenerate(
  chatId: string,
  messageId: number,
  swipeId: number,
  seq: number,
): void {
  flags.add(key(chatId, messageId, swipeId, seq));
}

/** 消费本槽位的自动生成标记:有则删除并返回 true(只触发一次)。 */
export function consumeAutoGenerate(
  chatId: string,
  messageId: number,
  swipeId: number,
  seq: number,
): boolean {
  const k = key(chatId, messageId, swipeId, seq);
  if (!flags.has(k)) return false;
  flags.delete(k);
  return true;
}

/** 撤销某楼层的全部标记(写回正文失败时调用)。 */
export function clearAutoGenerateForFloor(chatId: string, messageId: number): void {
  const prefix = `${chatId}|${messageId}|`;
  for (const k of [...flags]) {
    if (k.startsWith(prefix)) flags.delete(k);
  }
}

/** 清空全部标记(切聊天 / 删楼后的全量重建时调用)。 */
export function clearAutoGenerateFlags(): void {
  flags.clear();
}

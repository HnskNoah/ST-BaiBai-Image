import { h, render } from 'vue';

import Card from '@/floor/Card.vue';
import { SlotRegistry } from '@/floor/registry';
import { historyEntries, latestStaleEntry, promptHash, readStore } from '@/floor/storage';
import { getContext, type STContext } from '@/st/context';
import { BBI_SLOT_SELECTOR, parseImageTagContent, parseImageTags } from '@/st/imageTagRegex';

/**
 * 楼层水合框架（DESIGN-FLOOR-UI.md §5.2 / §6）。
 *
 * 渲染事件触发 → 定位楼层 .mes_text → 锚点列表（DOM 顺序）与
 * parseImageTags(message.mes) 解析出的 tag 列表按序一一配对 → 每个锚点
 * 挂载一张卡片。锚点每次渲染重建，水合每次事件重建，全程幂等。
 */

export const slotRegistry = new SlotRegistry();

let bound = false;

/** 楼层 .mes_text 元素；楼层不在 DOM（未渲染/群聊懒渲染）时返回 null。 */
function findMesText(messageId: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.mes[mesid="${messageId}"] .mes_text`);
}

function unmountKey(key: string): void {
  const record = slotRegistry.get(key);
  if (!record) return;
  // 显式卸载：锚点容器可能已脱离 DOM（.mes_text 被 ST 整体重写），
  // render(null, container) 对已脱离元素依然安全。
  render(null, record.container);
  slotRegistry.delete(key);
}

/** 卸载并清空全部记录（切聊天 / 删除楼层后全量重建）。 */
function unmountAll(): void {
  for (const key of slotRegistry.keys()) {
    unmountKey(key);
  }
}

/**
 * 水合单条消息的全部槽位。幂等：先卸载该消息旧记录（跨 swipeId），
 * 再按「锚点顺序 = tag 顺序」配对挂载。
 */
export function hydrateMessage(messageId: number, ctx: STContext): void {
  const chatId = ctx.getCurrentChatId();
  for (const key of slotRegistry.keysByMessage(chatId, messageId)) {
    unmountKey(key);
  }

  const message = ctx.chat[messageId];
  if (!message) return;

  const tags = parseImageTags(message.mes);
  if (tags.length === 0) return;

  const mesText = findMesText(messageId);
  if (!mesText) return; // 楼层不在 DOM，等下次渲染事件再来

  const anchors = [...mesText.querySelectorAll<HTMLElement>(BBI_SLOT_SELECTOR)];
  if (anchors.length !== tags.length) {
    console.warn(
      `[柏宝绘] 楼层 #${messageId} 锚点 ${anchors.length} 个 ≠ 生图 tag ${tags.length} 个，按少者配对`,
    );
  }
  const count = Math.min(anchors.length, tags.length);
  const swipeId = message.swipe_id ?? 0;

  for (let seq = 0; seq < count; seq++) {
    const key = slotRegistry.key(chatId, messageId, swipeId, seq);
    const anchor = anchors[seq];
    // 从 extra 恢复：当前 tag 原文重算 hash 匹配同槽位历史 → ready（可翻页）；
    // 无匹配但有旧提示词结果 → stale（DESIGN-FLOOR-UI.md §7.1）。
    const store = readStore(message);
    const hash = promptHash(tags[seq]);
    const history = historyEntries(store, swipeId, hash, seq);
    const entry = history.length ? history[history.length - 1] : null;
    const staleEntry = entry ? null : latestStaleEntry(store, swipeId, hash, seq);
    const content = parseImageTagContent(tags[seq]);
    const vnode = h(Card, {
      prompt: content.tag,
      nl: content.nl,
      tag: tags[seq],
      messageId,
      seq,
      swipeId,
      history,
      staleEntry,
    });
    render(vnode, anchor);
    slotRegistry.set(key, { container: anchor, vnode });
  }
}

/** 全量重水合：先卸载全部，再逐条水合。切聊天 / 删除楼层后调用。 */
export function hydrateAll(ctx: STContext): void {
  unmountAll();
  for (let messageId = 0; messageId < ctx.chat.length; messageId++) {
    hydrateMessage(messageId, ctx);
  }
}

/**
 * 绑定 ST 渲染事件并水合现有楼层（幂等，可重复调用）。
 * 事件并集（DESIGN-FLOOR-UI.md §6.1）：
 * - CHARACTER_MESSAGE_RENDERED / USER_MESSAGE_RENDERED：新楼层渲染
 * - MESSAGE_UPDATED：编辑保存后重渲染
 * - MESSAGE_SWIPED：滑动后重渲染
 * - MESSAGE_DELETED / CHAT_CHANGED：楼层结构变化，全量重建
 */
export function bindFloorHydration(): boolean {
  if (bound) return true;
  const ctx = getContext();
  if (!ctx?.eventSource) return false;

  bound = true;
  const { eventSource, eventTypes } = ctx;
  const onMessage = (messageId: unknown) => {
    const id = Number(messageId);
    if (!Number.isInteger(id)) return;
    const current = getContext();
    if (current) hydrateMessage(id, current);
  };
  const onFullReload = () => {
    const current = getContext();
    if (current) hydrateAll(current);
  };

  eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onMessage);
  eventSource.on(eventTypes.USER_MESSAGE_RENDERED, onMessage);
  eventSource.on(eventTypes.MESSAGE_UPDATED, onMessage);
  eventSource.on(eventTypes.MESSAGE_SWIPED, onMessage);
  eventSource.on(eventTypes.MESSAGE_DELETED, onFullReload);
  eventSource.on(eventTypes.CHAT_CHANGED, onFullReload);

  // 刷新页面恢复：现有楼层已渲染完，直接全量水合
  hydrateAll(ctx);
  return true;
}

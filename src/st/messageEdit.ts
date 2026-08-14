import { getContext, type STContext, type STMessage } from '@/st/context';

function findMessage(floor: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#chat .mes[mesid="${floor}"]`);
}

function activeEditorText(floor: number): string | null {
  return findMessage(floor)?.querySelector<HTMLTextAreaElement>('#curEditTextarea')?.value ?? null;
}

function currentSwipeId(message: STMessage): number | null {
  if (!Array.isArray(message.swipes)) return null;
  return typeof message.swipe_id === 'number' ? message.swipe_id : 0;
}

function setMessageText(message: STMessage, text: string): void {
  message.mes = text;
  const swipeId = currentSwipeId(message);
  if (swipeId === null || !message.swipes || swipeId < 0 || swipeId >= message.swipes.length) return;
  message.swipes[swipeId] = text;
}

function settleActiveEditor(floor: number, text: string): boolean {
  const message = findMessage(floor);
  const editor = message?.querySelector<HTMLTextAreaElement>('#curEditTextarea');
  if (!message || !editor) return false;

  editor.value = text;
  message.querySelector<HTMLElement>('.mes_edit_cancel')?.click();
  return true;
}

async function emitMessageEvent(context: STContext, event: string | undefined, floor: number): Promise<void> {
  if (event && context.eventSource.emit) await context.eventSource.emit(event, floor);
}

async function refreshRenderedMessage(context: STContext, message: STMessage, floor: number): Promise<void> {
  if (!findMessage(floor)) return;
  if (typeof context.updateMessageBlock === 'function') {
    try {
      await context.updateMessageBlock(floor, message);
      return;
    } catch {
      // 局部刷新失败时再退回整段聊天重载。
    }
  }
  await context.reloadCurrentChat?.();
}

export type ApplyMessageResult =
  | 'saved'
  | 'chat-changed'
  | 'floor-changed'
  | 'swipe-changed'
  | 'unavailable';

/**
 * 以 compare-and-swap 方式修改消息正文：只有聊天、swipe 和原文都仍与请求开始时一致才落盘。
 * 保存失败时同时回滚 mes 与当前 swipe，避免留下半写状态。
 */
export async function applyMessageText(
  floor: number,
  expectedText: string,
  nextText: string,
  expectedChatId: string,
  expectedSwipeId: number | null,
): Promise<ApplyMessageResult> {
  const context = getContext();
  if (!context?.saveChat) return 'unavailable';
  if (context.getCurrentChatId?.() !== expectedChatId) return 'chat-changed';

  const message = context.chat?.[floor];
  if (!message) return 'unavailable';
  if (currentSwipeId(message) !== expectedSwipeId) return 'swipe-changed';
  if ((activeEditorText(floor) ?? message.mes) !== expectedText) return 'floor-changed';

  const previousText = message.mes;
  const swipeId = currentSwipeId(message);
  const previousSwipeText = swipeId !== null ? message.swipes?.[swipeId] : undefined;
  setMessageText(message, nextText);

  try {
    await context.saveChat();
  } catch (error) {
    message.mes = previousText;
    if (swipeId !== null && message.swipes && swipeId >= 0 && swipeId < message.swipes.length) {
      message.swipes[swipeId] = previousSwipeText ?? previousText;
    }
    throw error;
  }

  await emitMessageEvent(context, context.eventTypes.MESSAGE_EDITED, floor).catch(error => {
    console.warn('[柏宝绘] tag 已保存，但 MESSAGE_EDITED 事件发送失败', error);
  });
  if (!settleActiveEditor(floor, message.mes)) {
    await refreshRenderedMessage(context, message, floor).catch(error => {
      console.warn('[柏宝绘] tag 已保存，但楼层刷新失败', error);
    });
    await emitMessageEvent(context, context.eventTypes.MESSAGE_UPDATED, floor).catch(error => {
      console.warn('[柏宝绘] tag 已保存，但 MESSAGE_UPDATED 事件发送失败', error);
    });
  }
  return 'saved';
}

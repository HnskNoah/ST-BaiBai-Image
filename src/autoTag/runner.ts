import { requestCompletion, requestViaMainApi } from '@/api/client';
import { readBookMemory } from '@/autoTag/bookMemory';
import { buildAutoTagMessages } from '@/autoTag/prompt';
import { injectImageTags, parseImagePlan, sourceLineCount } from '@/autoTag/protocol';
import { applyMessageText } from '@/st/messageEdit';
import { getContext, type STMessage } from '@/st/context';
import { stripImageTags } from '@/st/imageTagRegex';
import { getTagGenChannel, settings } from '@/state/settings';

const ignoredRenderTypes = new Set(['extension', 'first_message', 'command', 'impersonate']);
const processed = new Set<string>();
const running = new Map<string, AbortController>();
let bound = false;

function activeSwipeId(message: STMessage): number | null {
  if (!Array.isArray(message.swipes)) return null;
  return typeof message.swipe_id === 'number' ? message.swipe_id : 0;
}

function textHash(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function isAiStoryMessage(message: STMessage | undefined): message is STMessage {
  if (!message || message.is_user || !message.mes?.trim()) return false;
  return !(message.is_system && typeof message.extra?.type === 'string');
}

interface RunOptions {
  /** 手动触发(楼层按钮):绕过 autoTag.enabled 与 processed 去重;空结果也给出反馈。 */
  manual?: boolean;
  /** 重新生成:先把已有 tag 从正文剔除再分析/注入;旧图片保留在卡片历史里。 */
  replace?: boolean;
}

async function runForFloor(floor: number, opts: RunOptions = {}): Promise<void> {
  const context = getContext();
  if (!context || !settings.enabled) return;
  if (!opts.manual && !settings.autoTag.enabled) return;
  const message = context.chat[floor];
  if (!isAiStoryMessage(message)) return;
  const rawSource = message.mes;
  if (/<\/?bbi_image\b/i.test(rawSource) && !opts.replace) {
    // 手动路径在按钮层已弹过「重新生成」确认,到这里仍不带 replace = 用户没确认或状态已变,静默放弃
    if (!opts.manual) console.debug(`[柏宝绘] 第 ${floor} 楼已经含有 bbi_image tag，跳过自动分析`);
    return;
  }
  // replace:分析和注入都基于剔除旧 tag 后的正文;写回时旧 tag 随之消失
  const source = opts.replace ? stripImageTags(rawSource) : rawSource;
  if (!source.trim()) return;

  const chatId = context.getCurrentChatId?.() ?? '';
  if (!chatId) return;
  const swipeId = activeSwipeId(message);
  const identity = `${chatId}\u0000${floor}\u0000${swipeId ?? 'none'}\u0000${textHash(source)}`;
  // 手动是显式意图:即使同一正文自动流程已处理过(比如结论是无需插图)也照跑,
  // 但仍写入 processed,防止自动流程随后对同一正文重复请求。
  if (!opts.manual && processed.has(identity)) return;
  processed.add(identity);

  const slot = `${chatId}\u0000${floor}`;
  running.get(slot)?.abort();
  const controller = new AbortController();
  running.set(slot, controller);

  try {
    const memory = settings.autoTag.useBaiBaiBook
      ? readBookMemory(floor, context.chat[floor]?.mes ?? '')
      : null;
    const messages = await buildAutoTagMessages(
      context,
      floor,
      settings.autoTag,
      memory,
      opts.replace ? source : undefined,
    );
    const channel = getTagGenChannel();
    const raw = channel
      ? await requestCompletion(channel, messages, { signal: controller.signal })
      : await requestViaMainApi(messages, { signal: controller.signal });
    if (controller.signal.aborted) {
      processed.delete(identity);
      return;
    }

    const plan = parseImagePlan(raw, sourceLineCount(source), settings.autoTag.maxImages);
    if (!plan.images.length) {
      if (opts.manual) toastr.info('模型认为本楼没有值得插图的画面', '柏宝绘');
      else console.debug(`[柏宝绘] 第 ${floor} 楼无需插图`);
      return;
    }

    const nextText = injectImageTags(source, plan.images);
    // CAS 的比对基准是楼层当前真实正文(含旧 tag);nextText 从剔除旧 tag 的 source 推出
    const result = await applyMessageText(floor, rawSource, nextText, chatId, swipeId);
    if (result === 'saved') {
      toastr.success(`已在第 ${floor} 楼插入 ${plan.images.length} 个生图 tag`, '柏宝绘');
      return;
    }
    console.info(`[柏宝绘] 第 ${floor} 楼在分析期间发生变化，放弃写入：${result}`);
    toastr.warning('正文、聊天或 swipe 已发生变化，本次没有写入生图 tag', '柏宝绘');
  } catch (error) {
    // 请求失败或被切换聊天取消时允许同一正文在后续重新渲染后重试。
    processed.delete(identity);
    if (controller.signal.aborted) return;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[柏宝绘] 第 ${floor} 楼自动生成 tag 失败`, error);
    toastr.error(message, '柏宝绘自动 tag 失败');
  } finally {
    if (running.get(slot) === controller) running.delete(slot);
  }
}

function cancelAll(): void {
  for (const controller of running.values()) controller.abort();
  running.clear();
}

/**
 * 楼层按钮的手动入口。replace=true 用于「已有 tag 重新生成」:
 * 剔除旧 tag → 分析 → 写回新 tag(旧 tag 随写回消失,旧图留在卡片历史)。
 */
export async function requestFloorTags(floor: number, opts: { replace?: boolean } = {}): Promise<void> {
  await runForFloor(floor, { manual: true, replace: opts.replace });
}

/** 监听 ST 的最终角色消息渲染事件；不回扫旧聊天，只处理绑定之后新落地的正文。 */
export function bindAutoTagging(): void {
  if (bound) return;
  const context = getContext();
  if (!context?.eventSource || !context.eventTypes.CHARACTER_MESSAGE_RENDERED) return;
  bound = true;

  context.eventSource.on(context.eventTypes.CHARACTER_MESSAGE_RENDERED, (messageId: unknown, type: unknown) => {
    if (typeof type === 'string' && ignoredRenderTypes.has(type)) return;
    const floor = typeof messageId === 'number' ? messageId : Number(messageId);
    if (!Number.isInteger(floor) || floor < 0) return;
    // 让 ST 先完成本次消息/swipe 的内部同步，再截取稳定正文。
    setTimeout(() => void runForFloor(floor), 0);
  });
  context.eventSource.on(context.eventTypes.CHAT_CHANGED, cancelAll);
}

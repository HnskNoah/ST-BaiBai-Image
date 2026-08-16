import { requestCompletion, requestViaMainApi } from '@/api/client';
import { readBookMemory } from '@/autoTag/bookMemory';
import { applyCharRefs, resolveCharAnchors } from '@/autoTag/charAnchors';
import { buildAutoTagMessages } from '@/autoTag/prompt';
import {
  applyAiChange,
  charTagLib,
  createAiEntry,
  type CharTagField,
} from '@/state/charTags';
import { injectImageTags, parseImagePlan, sourceLineCount, type ImagePlan } from '@/autoTag/protocol';
import { clearAutoGenerateForFloor, markForAutoGenerate } from '@/floor/autoGenerate';
import { applyMessageText } from '@/st/messageEdit';
import { getContext, type STMessage } from '@/st/context';
import { stripImageTags } from '@/st/imageTagRegex';
import { getTagGenChannel, isCurrentChatExcluded, settings } from '@/state/settings';

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

/** 把 AI 报告的 changes 落库:new = 建档;其余 = 单字段/raw/nl 变更(全部记历史)。 */
function applyPlanChanges(plan: ImagePlan, floor: number): void {
  for (const change of plan.changes) {
    if (change.field === 'new') {
      // value 可能是结构化字段的 JSON 串(protocol.ts 拼),也可能是整串 tag 文本
      let fields: Partial<Record<CharTagField, string>> | null = null;
      let value = '';
      if (change.value.startsWith('{')) {
        try {
          const parsed = JSON.parse(change.value) as Record<string, unknown>;
          const picked: Partial<Record<CharTagField, string>> = {};
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === 'string' && v.trim()) picked[k as CharTagField] = v.trim();
          }
          if (Object.keys(picked).length) fields = picked;
        } catch {
          /* 非 JSON → 当整串处理 */
        }
      }
      if (!fields && change.value) value = change.value;
      const ok = createAiEntry(
        { name: change.name, fields: fields ?? undefined, value, nl: change.nl, reason: change.reason },
        floor,
      );
      if (ok) console.info(`[柏宝绘] AI 建档角色「${change.name}」(第 ${floor} 楼)`);
    } else if (change.field === 'nl') {
      applyAiChange(change.name, 'nl', change.value || change.nl || '', change.reason, floor);
    } else {
      applyAiChange(change.name, change.field, change.value, change.reason, floor);
    }
  }
}

async function runForFloor(floor: number, opts: RunOptions = {}): Promise<void> {
  const context = getContext();
  if (!context || !settings.enabled) return;
  if (!opts.manual && !settings.autoTag.enabled) return;
  // 排除角色闸门(与柏宝书同名单):该角色名所在聊天的自动 tag 全流程停用,
  // 手动按钮也在 actionButton 层隐藏,这里做兜底(手动触发时给反馈)。
  if (isCurrentChatExcluded()) {
    if (opts.manual) toastr.warning('该角色已被排除，不生成生图 tag', '柏宝绘');
    return;
  }
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
      ? readBookMemory(floor, context.chat[floor]?.mes ?? '', context.name1)
      : null;
    // 角色固定外貌库:柏宝书新面孔先入库,然后返回库文本供 AI 判断变更/引用
    const library = await resolveCharAnchors(memory?.roles ?? [], source, controller.signal);
    const messages = await buildAutoTagMessages(
      context,
      floor,
      settings.autoTag,
      memory,
      opts.replace ? source : undefined,
      library,
    );
    const channel = getTagGenChannel();
    // 失败重试:请求异常与「返回无法解析/校验不通过」都视为可重试的异常(后者常见于模型没遵守协议);
    // 中止信号立即收手,不消耗重试。parseImagePlan 对坏输出抛错,「无画面」则是正常返回空数组。
    const retries = Math.max(0, Math.floor(Number(settings.autoTag.retryCount) || 0));
    let plan: ImagePlan | null = null;
    let lastError = '';
    for (let attempt = 0; attempt <= retries && !plan; attempt++) {
      if (controller.signal.aborted) {
        processed.delete(identity);
        return;
      }
      try {
        const raw = channel
          ? await requestCompletion(channel, messages, { signal: controller.signal })
          : await requestViaMainApi(messages, { signal: controller.signal });
        if (controller.signal.aborted) {
          processed.delete(identity);
          return;
        }
        plan = parseImagePlan(raw, sourceLineCount(source), settings.autoTag.maxImages);
      } catch (error) {
        if (controller.signal.aborted) {
          processed.delete(identity);
          return;
        }
        lastError = error instanceof Error ? error.message : String(error);
        console.warn(`[柏宝绘] 第 ${floor} 楼第 ${attempt + 1}/${retries + 1} 次生成 tag 失败`, error);
      }
    }
    if (!plan) {
      // 重试耗尽:允许同一正文在后续重新渲染后再试
      processed.delete(identity);
      toastr.error(
        `${lastError}${retries > 0 ? `(已自动重试 ${retries} 次)` : ''}`,
        '柏宝绘自动 tag 失败',
      );
      return;
    }

    // 角色库变更先落库(本楼发生的变化当楼生效),再用最新库替换 @占位符。
    // 解析成功即落库:外貌变化是剧情事实,与后续图片是否成功无关。
    applyPlanChanges(plan, floor);

    if (!plan.images.length) {
      if (opts.manual) toastr.info('模型认为本楼没有值得插图的画面', '柏宝绘');
      else console.debug(`[柏宝绘] 第 ${floor} 楼无需插图`);
      return;
    }

    // @占位符 替换:库里有的换成最新 tag,库里没有的剥掉(nl 部分优先条目的自然语言句)
    const unknownNames = new Set<string>();
    for (const image of plan.images) {
      const tagRes = applyCharRefs(image.tag, charTagLib.entries, 'tag');
      if (tagRes.text) image.tag = tagRes.text;
      if (image.nl) {
        const nlRes = applyCharRefs(image.nl, charTagLib.entries, 'nl');
        image.nl = nlRes.text;
        for (const n of nlRes.unknown) unknownNames.add(n);
      }
      for (const n of tagRes.unknown) unknownNames.add(n);
    }
    if (unknownNames.size) {
      console.warn('[柏宝绘] AI 引用了库里没有的角色占位符,已剥除:', [...unknownNames].join('、'));
    }

    const nextText = injectImageTags(source, plan.images);
    // 「写入 tag 后自动生成图片」:写回前先给每个新槽位挂标记——applyMessageText 内部会
    // 触发 MESSAGE_EDITED / MESSAGE_UPDATED,卡片水合挂载时消费标记并自动开始生成
    // (见 floor/autoGenerate.ts);写回失败则撤销标记。
    const marked = settings.autoTag.autoGenerate;
    if (marked) {
      const markSwipeId = message.swipe_id ?? 0;
      for (let seq = 0; seq < plan.images.length; seq++) {
        markForAutoGenerate(chatId, floor, markSwipeId, seq);
      }
    }
    // CAS 的比对基准是楼层当前真实正文(含旧 tag);nextText 从剔除旧 tag 的 source 推出
    const result = await applyMessageText(floor, rawSource, nextText, chatId, swipeId);
    if (result === 'saved') {
      toastr.success(`已在第 ${floor} 楼插入 ${plan.images.length} 个生图 tag`, '柏宝绘');
      return;
    }
    if (marked) clearAutoGenerateForFloor(chatId, floor);
    console.info(`[柏宝绘] 第 ${floor} 楼在分析期间发生变化，放弃写入：${result}`);
    toastr.warning('正文、聊天或 swipe 已发生变化，本次没有写入生图 tag', '柏宝绘');
  } catch (error) {
    // 请求失败或被切换聊天取消时允许同一正文在后续重新渲染后重试。
    processed.delete(identity);
    // 异常发生在挂标记之后时(如保存失败回滚),撤销本楼标记,不留残留
    clearAutoGenerateForFloor(chatId, floor);
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

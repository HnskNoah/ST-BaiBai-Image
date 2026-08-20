import { requestCompletion, requestViaMainApi } from '@/api/client';
import { readBookMemory } from '@/autoTag/bookMemory';
import {
  applyPositionedCharRefs,
  resolveCharAnchors,
  type PositionedCharOp,
} from '@/autoTag/charAnchors';
import { prepareTargetText } from '@/autoTag/clean';
import { buildAutoTagMessages } from '@/autoTag/prompt';
import {
  BBI_CHAR_EXTRA_KEY,
  CHAR_TAG_FIELDS,
  charTagsBeforeFloor,
  createCharTagNewOp,
  createCharTagSetOp,
  emptyCharFields,
  makeCharTagFloorDelta,
  readCharTagFloorDelta,
  recomputeCharTags,
  type CharTagAutoOp,
  type CharTagField,
} from '@/state/charTags';
import { injectImageTags, parseImagePlan, type ImagePlan } from '@/autoTag/protocol';
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

/** 把 AI 报告的 changes 转成当前楼层操作;真正写回在正文 CAS 成功时一次完成。 */
function planChangeOps(plan: ImagePlan): PositionedCharOp[] {
  const ops: PositionedCharOp[] = [];
  for (const change of plan.changes) {
    let op: CharTagAutoOp | null = null;
    if (change.field === 'new') {
      // value 可能是结构化字段的 JSON 串(protocol.ts 拼),也可能是整串 tag 文本
      let fields: Partial<Record<CharTagField, string>> | null = null;
      let value = '';
      if (change.value.startsWith('{')) {
        try {
          const parsed = JSON.parse(change.value) as Record<string, unknown>;
          const picked: Partial<Record<CharTagField, string>> = {};
          for (const field of CHAR_TAG_FIELDS) {
            const value = parsed[field];
            if (typeof value === 'string' && value.trim()) picked[field] = value.trim();
          }
          if (Object.keys(picked).length) fields = picked;
        } catch {
          /* 非 JSON → 当整串处理 */
        }
      }
      if (!fields && change.value) value = change.value;
      op = createCharTagNewOp(
        {
          name: change.name,
          fields: { ...emptyCharFields(), ...(fields ?? {}) },
          raw: value,
          nl: change.nl ?? '',
          source: 'ai',
          desc: '',
        },
        change.reason,
      );
    } else if (change.field === 'nl') {
      op = createCharTagSetOp(change.name, 'nl', change.value || change.nl || '', change.reason);
    } else {
      op = createCharTagSetOp(change.name, change.field, change.value, change.reason);
    }
    if (op) ops.push({ op, sourceLine: change.sourceLine });
  }
  return ops.sort((left, right) => left.sourceLine - right.sourceLine);
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
  const preparedTarget = prepareTargetText(source, settings.excludes.customStripTags);
  if (!preparedTarget.segments.length) return;

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
    const memory = readBookMemory(floor, context.chat[floor]?.mes ?? '', context.name1);
    const entriesBefore = charTagsBeforeFloor(floor);
    // 纯本地渲染:建档由主请求在同一次输出里完成(changes 的 field="new")
    const anchors = resolveCharAnchors(entriesBefore);
    const messages = await buildAutoTagMessages(
      context,
      floor,
      settings.autoTag,
      memory,
      preparedTarget,
      anchors.text,
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
          ? await requestCompletion(channel, messages, {
              signal: controller.signal,
              source: `自动 tag(第 ${floor} 楼)`,
            })
          : await requestViaMainApi(messages, {
              signal: controller.signal,
              source: `自动 tag(第 ${floor} 楼)`,
            });
        if (controller.signal.aborted) {
          processed.delete(identity);
          return;
        }
        plan = parseImagePlan(
          raw,
          preparedTarget.segments,
          settings.autoTag.minImages,
          settings.autoTag.maxImages,
        );
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

    const planOps = planChangeOps(plan);
    const floorOps = planOps.map(item => item.op);
    const previousDelta = readCharTagFloorDelta(message);

    // @占位符按正文位置替换：变化前图片用旧档，变化位置及之后用新档。
    const unknownNames = new Set<string>();
    for (const image of plan.images) {
      const tagRes = applyPositionedCharRefs(
        image.tag,
        anchors.entries,
        planOps,
        image.sourceLine,
        'tag',
      );
      if (tagRes.text) image.tag = tagRes.text;
      if (image.nl) {
        const nlRes = applyPositionedCharRefs(
          image.nl,
          anchors.entries,
          planOps,
          image.sourceLine,
          'nl',
        );
        image.nl = nlRes.text;
        for (const n of nlRes.unknown) unknownNames.add(n);
      }
      for (const n of tagRes.unknown) unknownNames.add(n);
    }
    if (unknownNames.size) {
      // 模型认为这是角色、却没给它建档 —— 该角色在图里将完全没有外貌。
      // 这是漏建档唯一的确定性信号,藏进控制台等于没有,必须让用户看见。
      const names = [...unknownNames].join('、');
      console.warn('[柏宝绘] AI 引用了库里没有的角色占位符,已剥除:', names);
      toastr.warning(`角色「${names}」没有建档，本次画面中缺少其外貌`, '柏宝绘');
    }

    // 没有图片、没有角色变化、也没有旧楼层变化要清理时,保持原来的无写入早退。
    if (!plan.images.length && !floorOps.length && !previousDelta) {
      if (opts.manual) toastr.info('模型认为本楼没有值得插图的画面', '柏宝绘');
      else console.debug(`[柏宝绘] 第 ${floor} 楼无需插图`);
      return;
    }

    const nextText = plan.images.length ? injectImageTags(source, plan.images) : rawSource;
    // 「写入 tag 后自动生成图片」:写回前先给每个新槽位挂标记——applyMessageText 内部会
    // 触发 MESSAGE_EDITED / MESSAGE_UPDATED,卡片水合挂载时消费标记并自动开始生成
    // (见 floor/autoGenerate.ts);写回失败则撤销标记。
    const marked = plan.images.length > 0 && settings.autoTag.autoGenerate;
    if (marked) {
      const markSwipeId = message.swipe_id ?? 0;
      for (let seq = 0; seq < plan.images.length; seq++) {
        markForAutoGenerate(chatId, floor, markSwipeId, seq);
      }
    }
    // CAS 的比对基准是楼层当前真实正文(含旧 tag);nextText 从剔除旧 tag 的 source 推出
    const result = await applyMessageText(
      floor,
      rawSource,
      nextText,
      chatId,
      swipeId,
      message,
      {
        key: BBI_CHAR_EXTRA_KEY,
        value: makeCharTagFloorDelta(floorOps, swipeId ?? 0),
      },
    );
    if (result === 'saved') {
      recomputeCharTags();
      if (plan.images.length) {
        toastr.success(`已在第 ${floor} 楼插入 ${plan.images.length} 个生图 tag`, '柏宝绘');
      } else if (opts.manual) {
        toastr.info('模型认为本楼没有值得插图的画面', '柏宝绘');
      } else {
        console.debug(`[柏宝绘] 第 ${floor} 楼无需插图`);
      }
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

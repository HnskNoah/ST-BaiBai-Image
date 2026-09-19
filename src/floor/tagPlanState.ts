import { reactive } from 'vue';

/**
 * 卡片「AI 重选画面」的提示词规划运行态(模块级 store)。
 *
 * 与 genState 同样的理由必须放组件外:卡片生命周期由水合决定,任一兄弟槽位出图都会
 * 触发整楼重水合、把卡片连同组件内 ref 一起销毁;规划请求还在途,重建后的卡片要能
 * 认领回「重新规划中…」并给出取消入口。
 *
 * 与 genState 分开存放,不合并:genState 管的是出图请求(queued/generating/error + hash
 * 对账),这里管的是 LLM 提示词请求。两者各有并发/取消语义(取消出图不该误杀规划,
 * 反之亦然),混在一起只会让状态机互相污染。key 与 genState / registry / autoGenerate
 * 保持同构:chatId|messageId|swipeId|seq。
 *
 * 「取消」不在这里做:中止靠 autoTag/runner.ts 的 cancelFloorTags(每楼一把请求锁),
 * 本 store 只负责展示态与收尾认领。
 */

/** key → 任务票据。票据用于识别「迟到的收尾」,见 endTagPlan。 */
const planning = reactive(new Map<string, number>());

let nextToken = 1;

export interface TagPlanHandle {
  token: number;
}

export function isTagPlanning(key: string): boolean {
  return planning.has(key);
}

/** 开始规划;同 key 重复开始以新票据为准(旧任务的收尾不得清掉新任务)。 */
export function beginTagPlan(key: string): TagPlanHandle {
  const token = nextToken++;
  planning.set(key, token);
  return { token };
}

/** 结束规划:只有票据仍属本任务才清。 */
export function endTagPlan(key: string, handle: TagPlanHandle): void {
  if (planning.get(key) === handle.token) planning.delete(key);
}

/** 清空全部(切聊天 / 删楼后的全量重建;在途请求由 runner 的 cancelAll 中止)。 */
export function clearAllTagPlans(): void {
  planning.clear();
}

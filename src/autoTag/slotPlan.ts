import { formatPromptText, parseImageTagContent, parseImageTags } from '@/st/imageTagRegex';

/** 单条已占用画面摘要的截断长度:清单只是给模型「别撞车」用的,不是让它照抄的提示词。 */
const MAX_SUMMARY = 160;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 单槽重规划(autoTag/runner.ts 的 requestSlotTag)的任务备注。
 *
 * 目的:让模型明确「这次只重选第 N 张」,并把其余槽位已占用的画面一并报上——
 * 否则它很可能又选中相邻的同一瞬间,用户拿到的只是一张换皮图。
 *
 * 槽位顺序只取一份数据:parseImageTags(与正文、卡片、水合同一口径)。
 * 摘要用展示口径 formatPromptText 压成单行并截断:给模型的是「已有什么」的索引,
 * 不是要它逐字对照的原文。
 *
 * 纯函数、无宿主依赖:runner 在发请求前拼好传进 buildAutoTagMessages 的 taskNote。
 */
export function buildSlotTaskNote(rawSource: string, seq: number, maxSummary = MAX_SUMMARY): string {
  const tags = parseImageTags(rawSource ?? '');
  const occupied: string[] = [];
  for (let index = 0; index < tags.length; index += 1) {
    if (index === seq) continue;
    const content = parseImageTagContent(tags[index]);
    const summary = formatPromptText(content).replace(/\s*\n+\s*/g, ' / ').trim();
    occupied.push(`- 第 ${index + 1} 张：${summary ? truncate(summary, maxSummary) : '（无提示词）'}`);
  }

  const lines = [
    `【本次只重选第 ${seq + 1} 张画面】`,
    '本楼其余画面已经确定，请为这一张另选一个与它们明显不同的瞬间；images 数组必须恰好返回 1 项。',
  ];
  if (occupied.length) lines.push('已占用的画面：', ...occupied);
  return lines.join('\n');
}

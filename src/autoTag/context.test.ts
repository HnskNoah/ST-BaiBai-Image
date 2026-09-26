import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 世界书扫描文本的**顺序契约**:必须「最新在前」—— 目标楼在 index 0。
 *
 * 为什么这是契约而不是实现细节:ST 的扫描缓冲把**数组下标当深度**
 * (`WorldInfoBuffer.#initDepthBuffer`: `buffer[depth] = messages[depth]`),
 * 关键词只匹配 `slice(0, entry.scanDepth ?? world_info_depth)` —— 即「数组前 N 条」;
 * ST 主对话自己组装时也是先 `.reverse()` 再传(script.js 的 chatForWI,深度 0 = 最新一楼)。
 * 我们一度按楼号升序传:绿灯条目于是只在**窗口最早**的几楼里匹配(默认 Scan Depth = 2 ⇒ 几乎全灭),
 * 而蓝灯走 `constant` 分支、根本不查这段缓冲 —— 症状就是「蓝灯的书读得到、绿灯的书读不到」。
 *
 * 两条路径(主路径 `checkWorldInfo` 与降级路径 `getWorldInfoPrompt`)共用同一个数组,故一起锁。
 */

const mocks = vi.hoisted(() => ({
  checkArgs: null as string[] | null,
  promptArgs: null as string[] | null,
  checkAvailable: true,
}));

vi.mock('@/st/context', () => ({
  getContext: () => ({
    substituteParams: (text: string) => text,
    getWorldInfoPrompt: async (chat: string[]) => {
      mocks.promptArgs = [...chat];
      return { worldInfoBefore: '', worldInfoAfter: '', worldInfoDepth: [], anBefore: [], anAfter: [] };
    },
  }),
  getCheckWorldInfo: async () =>
    mocks.checkAvailable
      ? async (chat: string[]) => {
          mocks.checkArgs = [...chat];
          return { allActivatedEntries: new Set() };
        }
      : null,
  getEjsTemplate: () => null,
}));

vi.mock('@/state/settings', () => ({
  settings: {
    excludes: {
      excludedChars: [],
      excludedWorldNames: [],
      excludedWorldInfoPatterns: [],
      customStripTags: [],
    },
  },
}));

import { fetchWorldInfo } from '@/autoTag/context';

/** 楼号升序的三楼(0 = 最早,2 = 最新/目标楼),前缀走 name1(用户)/ 楼自身的 name。 */
const chat = [
  { mes: '第一楼正文', is_user: false, name: '小雪' },
  { mes: '第二楼正文', is_user: true, name: '我' },
  { mes: '第三楼正文', is_user: false, name: '小雪' },
] as never;

/** 期望:最新楼(index 0)、次新楼、最早楼 —— 与传楼顺序相反。 */
const NEWEST_FIRST = ['小雪: 第三楼正文', '我: 第二楼正文', '小雪: 第一楼正文'];

describe('世界书扫描文本的顺序', () => {
  beforeEach(() => {
    mocks.checkArgs = null;
    mocks.promptArgs = null;
    mocks.checkAvailable = true;
  });

  it('主路径(checkWorldInfo)最新在前:目标楼在 index 0', async () => {
    await fetchWorldInfo(chat, [0, 1, 2], '我', '小雪');
    expect(mocks.checkArgs).toEqual(NEWEST_FIRST);
  });

  it('降级路径(getWorldInfoPrompt,拿不到条目对象)同样是「最新在前」', async () => {
    mocks.checkAvailable = false;
    await fetchWorldInfo(chat, [0, 1, 2], '我', '小雪');
    expect(mocks.promptArgs).toEqual(NEWEST_FIRST);
  });

  it('窗口以 AI 楼为锚、user 楼照进,顺序仍是倒序(不是楼号升序)', async () => {
    // 少一楼也照样倒序:index 0 必须是 targets 的最后一个
    await fetchWorldInfo(chat, [1, 2], '我', '小雪');
    expect(mocks.checkArgs).toEqual(['小雪: 第三楼正文', '我: 第二楼正文']);
  });
});

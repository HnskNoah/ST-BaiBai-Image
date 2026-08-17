import { describe, expect, it } from 'vitest';

import { buildAutoTagMessages } from '@/autoTag/prompt';
import { settings, type AutoTagSettings } from '@/state/settings';
import type { STContext } from '@/st/context';

function context(): STContext {
  return {
    chat: [
      { name: 'User', is_user: true, is_system: false, mes: '上一层' },
      { name: 'Char', is_user: false, is_system: false, mes: '目标第一行\n\n目标第三行' },
    ],
    chatMetadata: {},
    name1: 'User',
    name2: 'Char',
    getCurrentChatId: () => 'chat-a',
    getRequestHeaders: () => ({}),
    saveMetadataDebounced: () => undefined,
    saveChat: async () => undefined,
    eventSource: { on: () => undefined },
    eventTypes: {
      USER_MESSAGE_RENDERED: 'user',
      CHARACTER_MESSAGE_RENDERED: 'character',
      MESSAGE_SENT: 'sent',
      GENERATION_STARTED: 'started',
      GENERATION_ENDED: 'ended',
      CHAT_CHANGED: 'changed',
      MESSAGE_EDITED: 'edited',
      MESSAGE_UPDATED: 'updated',
      MESSAGE_SWIPED: 'swiped',
      MESSAGE_DELETED: 'deleted',
    },
  };
}

describe('auto tag prompt', () => {
  it('marks only clean target paragraphs without pulling user messages before the earliest selected AI floor', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      maxImages: 3,
      retryCount: 1,
      autoGenerate: true,
      useBaiBaiBook: false,
      renderWorldInfoTemplates: true,
      prompts: { jailbreak: '附加规则', naiSpec: '', comfySpec: '', thinking: '', prefill: '' },
    };
    const messages = await buildAutoTagMessages(context(), 1, options, null);

    expect(messages[0].content).toContain('附加规则');
    expect(messages.some(m => m.content.includes('最多返回 3 个成员'))).toBe(true);
    expect(messages.some(m => m.content.includes('不得包含质量词'))).toBe(true);
    const user = messages[messages.length - 2];
    expect(user.role).toBe('user');
    expect(user.content).not.toContain('上一层');
    expect(user.content).toContain('目标第一行 ⟦P1⟧\n\n目标第三行 ⟦P2⟧');
    expect(user.content).not.toContain('[L0001]');
    expect(messages.some(message => message.content.includes('"position"'))).toBe(true);
  });

  it('counts context by AI floors, keeps interleaved user floors, and preserves prior image tags', async () => {
    const ctx = context();
    ctx.chat = [
      { name: 'User', is_user: true, is_system: false, mes: '更早用户楼' },
      {
        name: 'Char',
        is_user: false,
        is_system: false,
        mes: `<think>隐藏思维</think>
<bbs_start>上午</bbs_start>
上一个 AI 楼
<snow>状态栏</snow>
<bbi_image>1girl, long silver hair, red eyes<size>portrait</size></bbi_image>
<bbs_end>中午</bbs_end>
尾部状态`,
      },
      { name: 'User', is_user: true, is_system: false, mes: '中间用户楼' },
      { name: 'Char', is_user: false, is_system: false, mes: '当前目标楼' },
    ];
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      useBaiBaiBook: false,
      renderWorldInfoTemplates: true,
      prompts: { jailbreak: '', naiSpec: '', comfySpec: '', thinking: '', prefill: '' },
    };

    const oldTags = [...settings.excludes.customStripTags];
    const messages = await (async () => {
      settings.excludes.customStripTags = ['snow'];
      try {
        return await buildAutoTagMessages(ctx, 3, options, null);
      } finally {
        settings.excludes.customStripTags = oldTags;
      }
    })();
    const user = messages[messages.length - 2];
    expect(user.content).not.toContain('更早用户楼');
    expect(user.content).toContain('上一个 AI 楼');
    expect(user.content).toContain('<bbi_image>1girl, long silver hair, red eyes<size>portrait</size></bbi_image>');
    expect(user.content).toContain('中间用户楼');
    expect(user.content).not.toContain('隐藏思维');
    expect(user.content).not.toContain('状态栏');
    expect(user.content).not.toContain('尾部状态');
    expect(user.content).not.toContain('上下文楼层');
    expect(user.content).toContain('当前目标楼 ⟦P1⟧');
    expect(user.content).not.toContain('上一个 AI 楼 ⟦P');
  });

  it('attaches the built-in thinking checklist and <thinking> prefill by default', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      useBaiBaiBook: false,
      renderWorldInfoTemplates: true,
      prompts: { jailbreak: '', naiSpec: '', comfySpec: '', thinking: '', prefill: '' },
    };
    const messages = await buildAutoTagMessages(context(), 1, options, null);

    const thinkingMsg = messages.find(m => m.content.includes('输出前思考清单'));
    expect(thinkingMsg?.role).toBe('system');
    const last = messages[messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.content).toBe('<thinking>');
  });

  it('uses custom thinking/prefill when provided', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      useBaiBaiBook: false,
      renderWorldInfoTemplates: true,
      prompts: { jailbreak: '', naiSpec: '', comfySpec: '', thinking: '自定义清单', prefill: 'custom>' },
    };
    const messages = await buildAutoTagMessages(context(), 1, options, null);

    expect(messages.some(m => m.content.includes('自定义清单'))).toBe(true);
    expect(messages.some(m => m.content.includes('输出前思考清单'))).toBe(false);
    expect(messages[messages.length - 1].content).toBe('custom>');
  });
});

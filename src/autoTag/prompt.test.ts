import { describe, expect, it } from 'vitest';

import { buildAutoTagMessages } from '@/autoTag/prompt';
import { type AutoTagSettings } from '@/state/settings';
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
  it('numbers only the target floor and keeps selected context complete', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      maxImages: 3,
      useBaiBaiBook: false,
      renderWorldInfoTemplates: true,
      prompts: { jailbreak: '附加规则', naiSpec: '', comfySpec: '', thinking: '', prefill: '' },
    };
    const messages = await buildAutoTagMessages(context(), 1, options, null);

    expect(messages[0].content).toContain('附加规则');
    expect(messages.some(m => m.content.includes('最多返回 3 个成员'))).toBe(true);
    expect(messages.some(m => m.content.includes('不得包含质量词'))).toBe(true);
    expect(messages[messages.length - 1].content).toContain('上一层');
    expect(messages[messages.length - 1].content).toContain('[L0001] 目标第一行');
    expect(messages[messages.length - 1].content).toContain('[L0002] ');
    expect(messages[messages.length - 1].content).toContain('[L0003] 目标第三行');
    expect(messages[messages.length - 1].content).not.toContain('[L0001] 上一层');
  });
});

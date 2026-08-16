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
    expect(user.content).toContain('上一层');
    expect(user.content).toContain('[L0001] 目标第一行');
    expect(user.content).toContain('[L0002] ');
    expect(user.content).toContain('[L0003] 目标第三行');
    expect(user.content).not.toContain('[L0001] 上一层');
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

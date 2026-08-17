import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyMessageText } from '@/st/messageEdit';

function installContext(context: Record<string, unknown>): void {
  vi.stubGlobal('window', {
    SillyTavern: { getContext: () => context },
  });
  vi.stubGlobal('document', { querySelector: vi.fn(() => null) });
}

afterEach(() => vi.unstubAllGlobals());

describe('safe message editing', () => {
  it('updates mes and the active swipe, then emits edit/update events', async () => {
    const message = {
      name: 'Char',
      is_user: false,
      is_system: false,
      mes: '原文',
      swipes: ['旧页', '原文'],
      swipe_id: 1,
    };
    const emit = vi.fn(async () => undefined);
    const saveChat = vi.fn(async () => undefined);
    installContext({
      chat: [message],
      getCurrentChatId: () => 'chat-a',
      saveChat,
      eventSource: { emit },
      eventTypes: { MESSAGE_EDITED: 'edited', MESSAGE_UPDATED: 'updated' },
    });

    await expect(
      applyMessageText(0, '原文', '原文\n<bbi_image>scene</bbi_image>', 'chat-a', 1),
    ).resolves.toBe('saved');
    expect(message.mes).toContain('<bbi_image>scene</bbi_image>');
    expect(message.swipes[1]).toBe(message.mes);
    expect(saveChat).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenNthCalledWith(1, 'edited', 0);
    expect(emit).toHaveBeenNthCalledWith(2, 'updated', 0);
  });

  it('does not overwrite a message when the user changed its source during the request', async () => {
    const message = {
      name: 'Char',
      is_user: false,
      is_system: false,
      mes: '用户刚修改的正文',
      swipes: ['用户刚修改的正文'],
      swipe_id: 0,
    };
    const saveChat = vi.fn(async () => undefined);
    installContext({
      chat: [message],
      getCurrentChatId: () => 'chat-a',
      saveChat,
      eventSource: {},
      eventTypes: {},
    });

    await expect(
      applyMessageText(0, '请求开始时的原文', '带 tag 的旧原文', 'chat-a', 0),
    ).resolves.toBe('floor-changed');
    expect(message.mes).toBe('用户刚修改的正文');
    expect(saveChat).not.toHaveBeenCalled();
  });

  it('does not write into another swipe with identical text', async () => {
    const message = {
      name: 'Char',
      is_user: false,
      is_system: false,
      mes: '相同正文',
      swipes: ['相同正文', '相同正文'],
      swipe_id: 1,
    };
    const saveChat = vi.fn(async () => undefined);
    installContext({
      chat: [message],
      getCurrentChatId: () => 'chat-a',
      saveChat,
      eventSource: {},
      eventTypes: {},
    });

    await expect(
      applyMessageText(0, '相同正文', '新正文', 'chat-a', 0),
    ).resolves.toBe('swipe-changed');
    expect(saveChat).not.toHaveBeenCalled();
  });

  it('writes message extra together with the text and rejects a replaced floor object', async () => {
    const original = {
      name: 'Char',
      is_user: false,
      is_system: false,
      mes: '原文',
      swipes: ['原文'],
      swipe_id: 0,
      extra: {},
    };
    const replacement = { ...original, extra: {} };
    const context = {
      chat: [replacement],
      getCurrentChatId: () => 'chat-a',
      saveChat: vi.fn(async () => undefined),
      eventSource: {},
      eventTypes: {},
    };
    installContext(context);

    await expect(
      applyMessageText(
        0,
        '原文',
        '新正文',
        'chat-a',
        0,
        original,
        { key: 'bbiCharChanges', value: { v: 1, swipe: 0, ops: [] } },
      ),
    ).resolves.toBe('floor-changed');
    expect(replacement.mes).toBe('原文');
    expect(replacement.extra).toEqual({});
    expect(context.saveChat).not.toHaveBeenCalled();
  });

  it('rolls back message extra when saving fails', async () => {
    const message = {
      name: 'Char',
      is_user: false,
      is_system: false,
      mes: '原文',
      swipes: ['原文'],
      swipe_id: 0,
      extra: { keep: true },
    };
    installContext({
      chat: [message],
      getCurrentChatId: () => 'chat-a',
      saveChat: vi.fn(async () => {
        throw new Error('save failed');
      }),
      eventSource: {},
      eventTypes: {},
    });

    await expect(
      applyMessageText(
        0,
        '原文',
        '新正文',
        'chat-a',
        0,
        message,
        { key: 'bbiCharChanges', value: { v: 1, swipe: 0, ops: [] } },
      ),
    ).rejects.toThrow('save failed');
    expect(message.mes).toBe('原文');
    expect(message.extra).toEqual({ keep: true });
  });
});

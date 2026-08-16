import { describe, expect, it } from 'vitest';

import {
  clearAutoGenerateFlags,
  clearAutoGenerateForFloor,
  consumeAutoGenerate,
  markForAutoGenerate,
} from '@/floor/autoGenerate';

describe('auto generate flags', () => {
  it('consume returns true once for a marked slot, then false', () => {
    clearAutoGenerateFlags();
    markForAutoGenerate('chat1', 5, 0, 0);
    expect(consumeAutoGenerate('chat1', 5, 0, 0)).toBe(true);
    expect(consumeAutoGenerate('chat1', 5, 0, 0)).toBe(false);
  });

  it('distinguishes slots by chat/message/swipe/seq', () => {
    clearAutoGenerateFlags();
    markForAutoGenerate('chat1', 5, 0, 0);
    expect(consumeAutoGenerate('chat1', 5, 0, 1)).toBe(false);
    expect(consumeAutoGenerate('chat1', 5, 1, 0)).toBe(false);
    expect(consumeAutoGenerate('chat2', 5, 0, 0)).toBe(false);
    expect(consumeAutoGenerate('chat1', 5, 0, 0)).toBe(true);
  });

  it('clearAutoGenerateForFloor removes only that floor', () => {
    clearAutoGenerateFlags();
    markForAutoGenerate('chat1', 5, 0, 0);
    markForAutoGenerate('chat1', 5, 0, 1);
    markForAutoGenerate('chat1', 6, 0, 0);
    clearAutoGenerateForFloor('chat1', 5);
    expect(consumeAutoGenerate('chat1', 5, 0, 0)).toBe(false);
    expect(consumeAutoGenerate('chat1', 5, 0, 1)).toBe(false);
    expect(consumeAutoGenerate('chat1', 6, 0, 0)).toBe(true);
  });

  it('clearAutoGenerateFlags wipes everything', () => {
    markForAutoGenerate('chat1', 5, 0, 0);
    markForAutoGenerate('chat2', 1, 0, 0);
    clearAutoGenerateFlags();
    expect(consumeAutoGenerate('chat1', 5, 0, 0)).toBe(false);
    expect(consumeAutoGenerate('chat2', 1, 0, 0)).toBe(false);
  });
});

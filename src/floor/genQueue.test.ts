import { beforeEach, describe, expect, it } from 'vitest';

import { acquireNaiSlot, naiSlotBusy, resetNaiGate, setNaiConcurrency } from '@/floor/genQueue';

describe('NAI 并发闸门', () => {
  beforeEach(() => {
    resetNaiGate();
  });

  it('默认上限 1:第二个请求要等第一个 release', async () => {
    const release1 = await acquireNaiSlot();
    expect(naiSlotBusy()).toBe(true);

    let granted = false;
    const pending = acquireNaiSlot().then(release => {
      granted = true;
      return release;
    });
    // 还没 release,第二个不该拿到槽
    await Promise.resolve();
    expect(granted).toBe(false);

    release1();
    const release2 = await pending;
    expect(granted).toBe(true);
    release2();
    expect(naiSlotBusy()).toBe(false);
  });

  it('上限内的请求立刻通过', async () => {
    setNaiConcurrency(2);
    const a = await acquireNaiSlot();
    const b = await acquireNaiSlot();
    expect(naiSlotBusy()).toBe(true);
    a();
    b();
    expect(naiSlotBusy()).toBe(false);
  });

  it('调大上限立刻放行等待中的任务', async () => {
    const first = await acquireNaiSlot();
    let granted = false;
    const pending = acquireNaiSlot().then(release => {
      granted = true;
      return release;
    });
    await Promise.resolve();
    expect(granted).toBe(false);

    setNaiConcurrency(3);
    const second = await pending;
    expect(granted).toBe(true);
    first();
    second();
  });

  it('已取消的 signal 直接抛错,不占槽位', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(acquireNaiSlot(controller.signal)).rejects.toThrow();
    expect(naiSlotBusy()).toBe(false);
  });

  it('排队期间被取消:抛错并从队列摘除,不会之后再占槽', async () => {
    const release1 = await acquireNaiSlot();
    const controller = new AbortController();
    const pending = acquireNaiSlot(controller.signal);
    // 尚在排队时取消
    controller.abort();
    await expect(pending).rejects.toThrow();

    // 释放第一个后,被取消的那个不该悄悄占用槽位
    release1();
    expect(naiSlotBusy()).toBe(false);
    const release2 = await acquireNaiSlot();
    release2();
  });

  it('release 幂等:重复调用不会把计数减穿', async () => {
    const release = await acquireNaiSlot();
    release();
    release();
    release();
    expect(naiSlotBusy()).toBe(false);
    // 计数没被减成负数 → 仍只允许 1 个并发
    const a = await acquireNaiSlot();
    expect(naiSlotBusy()).toBe(true);
    a();
  });

  it('并发上限至少为 1(非法值兜底)', async () => {
    setNaiConcurrency(0);
    const a = await acquireNaiSlot();
    expect(naiSlotBusy()).toBe(true);
    a();
  });
});

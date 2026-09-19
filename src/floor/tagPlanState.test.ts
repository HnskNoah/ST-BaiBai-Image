import { beforeEach, describe, expect, it } from 'vitest';

import { beginTagPlan, clearAllTagPlans, endTagPlan, isTagPlanning } from '@/floor/tagPlanState';

const KEY = 'c|1|0|0';

describe('tagPlanState', () => {
  beforeEach(() => {
    clearAllTagPlans();
  });

  it('begin 后处于规划中,票据收尾后清除', () => {
    const handle = beginTagPlan(KEY);
    expect(isTagPlanning(KEY)).toBe(true);
    endTagPlan(KEY, handle);
    expect(isTagPlanning(KEY)).toBe(false);
  });

  it('旧任务的收尾不得清掉新任务的记录', () => {
    const first = beginTagPlan(KEY);
    const second = beginTagPlan(KEY);
    endTagPlan(KEY, first);
    expect(isTagPlanning(KEY)).toBe(true);
    endTagPlan(KEY, second);
    expect(isTagPlanning(KEY)).toBe(false);
  });

  it('无记录时 end 是安全空操作', () => {
    expect(() => endTagPlan(KEY, { token: 1 })).not.toThrow();
    expect(isTagPlanning(KEY)).toBe(false);
  });

  it('clearAllTagPlans 清空全部槽位', () => {
    beginTagPlan(KEY);
    beginTagPlan('c|2|0|0');
    clearAllTagPlans();
    expect(isTagPlanning(KEY)).toBe(false);
    expect(isTagPlanning('c|2|0|0')).toBe(false);
  });
});

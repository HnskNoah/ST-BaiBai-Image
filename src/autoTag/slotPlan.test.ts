import { describe, expect, it } from 'vitest';

import { buildSlotTaskNote } from '@/autoTag/slotPlan';
import { serializeImageTag } from '@/st/imageTagRegex';

function tag(text: string, nl = ''): string {
  return serializeImageTag({ tag: text, nl, negative: '', characters: [], size: 'portrait' });
}

describe('buildSlotTaskNote', () => {
  it('列出除目标槽位外的其余画面摘要,并要求恰好 1 张', () => {
    const source = [
      `正文`,
      tag('1girl, classroom'),
      tag('1boy, rooftop', 'A boy on the roof.'),
      tag('cat, windowsill'),
    ].join('\n');
    const note = buildSlotTaskNote(source, 1);
    expect(note).toContain('【本次只重选第 2 张画面】');
    expect(note).toContain('第 1 张：1girl, classroom');
    expect(note).not.toContain('第 2 张：');
    expect(note).toContain('第 3 张：cat, windowsill');
    expect(note).toContain('images 数组必须恰好返回 1 项');
  });

  it('单张楼只有说明,没有已占用清单', () => {
    const note = buildSlotTaskNote(tag('1girl, sunset'), 0);
    expect(note).toContain('【本次只重选第 1 张画面】');
    expect(note).not.toContain('已占用的画面：');
  });

  it('正文里没有 tag 时不抛错(边界容忍)', () => {
    const note = buildSlotTaskNote('纯正文', 0);
    expect(note).toContain('【本次只重选第 1 张画面】');
    expect(note).not.toContain('已占用的画面：');
  });

  it('摘要压成单行并截断,避免把整段提示词灌进备注', () => {
    const long = 'x'.repeat(400);
    const source = [tag('aaa'), tag(long)].join('\n');
    const note = buildSlotTaskNote(source, 0);
    expect(note).toContain('第 2 张：');
    expect(note).not.toContain(long);
    expect(note).toContain('…');
    // tag / nl 两段之间不得带换行漏进清单(parseImageTagContent 会把 nl 内部换行折成空格,
    // 这里锁的是段与段之间的分隔符也被压成单行)
    const withNl = buildSlotTaskNote(
      [tag('aaa'), tag('1girl', 'A girl.\nSecond line.')].join('\n'),
      0,
    );
    expect(withNl).toContain('第 2 张：1girl / A girl. Second line.');
  });
});

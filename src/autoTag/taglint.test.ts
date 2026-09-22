import { describe, expect, it } from 'vitest';

import { lintImagePlan, type LintableImage, type TagLintMode } from '@/autoTag/taglint';

/**
 * taglint 确定性守卫(autoTag/taglint.ts):出图前的机械修正。
 * 每条用例对应一条实跑复发过的违规形态(来源见模块头注释),外加「干净输出零修改」回归守卫。
 */

function image(tag: string, nl = '', characters: Array<{ tag: string; nl?: string }> = []): LintableImage {
  return { tag, nl, characters };
}

function lint(images: LintableImage[], mode: TagLintMode = 'latent') {
  return lintImagePlan(images, { mode, where: '第 3 楼' });
}

describe('taglint 确定性守卫', () => {
  it('表情/视线接 on 剥掉,称谓前缀写法不误伤', () => {
    const [item] = [image('1girl, smile on green hair girl, black hair girl looking at another')];
    lint([item]);
    expect(item.tag).toBe('1girl, smile, black hair girl looking at another');
  });

  it('视线 on 形式剥掉(looking down on 语义会反的那种)', () => {
    const [item] = [image('1girl, black hair girl looking down on silver hair girl, sweat on black hair boy')];
    lint([item]);
    expect(item.tag).toBe('1girl, black hair girl looking down, sweat');
  });

  it('发色/瞳色短语剥 on;合法的穿戴件绑定不动', () => {
    const [item] = [image('long silver hair on silver hair girl, blue eyes on silver hair girl, white dress on green hair girl, penis on black hair boy')];
    lint([item]);
    expect(item.tag).toBe('long silver hair, blue eyes, white dress on green hair girl, penis on black hair boy');
  });

  it('完全同名 tag 去重(同色瞳色每人一份落在它头上)', () => {
    const [item] = [image('1girl, black eyes, black eyes, smile, smile')];
    lint([item]);
    expect(item.tag).toBe('1girl, black eyes, smile');
  });

  it('size 词混进 tag 串直接剔除', () => {
    const [item] = [image('2boys 1girl, landscape, medium shot, smile')];
    lint([item]);
    expect(item.tag).toBe('2boys 1girl, medium shot, smile');
  });

  it('同人身份 tag 补括号转义;已转义的不重复转义', () => {
    const [item] = [image('1girl, kasumi (blue archive), shorekeeper \\(wuthering waves\\)')];
    lint([item]);
    expect(item.tag).toBe('1girl, kasumi \\(blue archive\\), shorekeeper \\(wuthering waves\\)');
  });

  it('自造人数词归一到标准词;自造总数词在已有真计数时剔除、没有时保留', () => {
    const [withCount] = [image('1man, 2men, 1woman, 1girl, 2people')];
    const [countOnly] = [image('2people')];
    lint([withCount, countOnly]);
    expect(withCount.tag).toBe('1boy, 2boys, 1girl');
    expect(countOnly.tag).toBe('2people');
  });

  it('单串模式剥 nl 里的中文', () => {
    const [item] = [image('1girl, smile', 'A girl with 清冷 eyes looks up.')];
    lint([item]);
    expect(item.nl).toBe('A girl with eyes looks up.');
  });

  it('v5 形态跳过绑定类规则与 nl 中文剥除,去重照常', () => {
    const [item] = [
      image('girl, black eyes on 小雪, girl', '小雪 looks up.', [{ tag: 'girl, smile, smile' }]),
    ];
    lint([item], 'v5');
    expect(item.tag).toBe('girl, black eyes on 小雪');
    expect(item.nl).toBe('小雪 looks up.');
    expect(item.characters[0].tag).toBe('girl, smile');
  });

  it('角色提示词的 tag 也走同一套修正', () => {
    const [item] = [image('1girl', '', [{ tag: 'girl, looking away on silver hair girl, girl' }])];
    lint([item]);
    expect(item.characters[0].tag).toBe('girl, looking away');
  });

  it('干净输出零修改(回归守卫:lint 不该碰合规的 tag)', () => {
    const clean = image(
      '2girls, medium shot, black hair, blue eyes, silver hair, red eyes, white dress, red dress, waving, smile, looking at viewer, eating dango, blush, looking away, park, sunset',
      'Two girls as the main focus, medium shot, in a park at sunset. No other people or duplicate identities are present.',
    );
    const res = lint([clean]);
    expect(res.fixed).toBe(0);
    expect(res.details).toEqual([]);
    expect(clean.tag).toBe(
      '2girls, medium shot, black hair, blue eyes, silver hair, red eyes, white dress, red dress, waving, smile, looking at viewer, eating dango, blush, looking away, park, sunset',
    );
  });
});

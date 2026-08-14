import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  parseWorkflowTemplate,
  randomSeed,
  renderWorkflowTemplate,
  type ComfyWorkflow,
} from '@/backends/comfyui';

const TEMPLATE = JSON.stringify({
  '3': {
    class_type: 'KSampler',
    inputs: { seed: '%seed%', text: '%prompt%', neg: '%negative_prompt%' },
  },
});

function seedOf(workflow: ComfyWorkflow): unknown {
  return (workflow['3'] as { inputs: { seed: unknown } }).inputs.seed;
}

afterEach(() => vi.restoreAllMocks());

describe('randomSeed', () => {
  it('returns an integer in [0, 2**53)', () => {
    const seed = randomSeed();
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThan(2 ** 53);
  });

  it('is derived from Math.random (range = Python random.randint(0, 2**53 - 1))', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(randomSeed()).toBe(Math.floor(0.5 * 2 ** 53));
  });

  it('produces different seeds across calls', () => {
    const seeds = new Set(Array.from({ length: 50 }, () => randomSeed()));
    expect(seeds.size).toBeGreaterThan(1);
  });
});

describe('parseWorkflowTemplate', () => {
  it('hints that placeholders must be quoted strings when JSON parse fails on %', () => {
    try {
      parseWorkflowTemplate('{"3":{"class_type":"KSampler","inputs":{"seed":%seed%}}}');
      expect.unreachable('should throw');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('占位符必须写成字符串形式');
      expect(message).toContain('"%seed%"');
    }
  });
});

describe('renderWorkflowTemplate with %seed%', () => {
  it('replaces exact %seed% with a number (not string)', () => {
    const workflow = renderWorkflowTemplate(TEMPLATE, { prompt: '1girl' });
    expect(seedOf(workflow)).toBeTypeOf('number');
    expect(seedOf(workflow)).toBeGreaterThanOrEqual(0);
    expect(seedOf(workflow)).toBeLessThan(2 ** 53);
  });

  it('uses the explicitly passed seed when provided', () => {
    const workflow = renderWorkflowTemplate(TEMPLATE, { prompt: '1girl', seed: 42 });
    expect(seedOf(workflow)).toBe(42);
  });

  it('uses the passed seed even when it is 0', () => {
    const workflow = renderWorkflowTemplate(TEMPLATE, { prompt: '1girl', seed: 0 });
    expect(seedOf(workflow)).toBe(0);
  });

  it('replaces every %seed% across all nodes with the same value', () => {
    const multi = JSON.stringify({
      '3': { class_type: 'KSampler', inputs: { seed: '%seed%', text: '%prompt%' } },
      '7': { class_type: 'RandomNoise', inputs: { noise_seed: '%seed%', note: 'seed=%seed% here' } },
      '9': { class_type: 'SomeNode', inputs: { value: 3 } },
    });
    const workflow = renderWorkflowTemplate(multi, { prompt: '1girl', seed: 12345 });
    const n3 = workflow['3'] as { inputs: { seed: unknown } };
    const n7 = workflow['7'] as { inputs: { noise_seed: unknown; note: unknown } };
    expect(n3.inputs.seed).toBe(12345);
    expect(n7.inputs.noise_seed).toBe(12345);
    // 嵌在字符串里的 %seed% 也被替换成同一个值
    expect(n7.inputs.note).toBe('seed=12345 here');
  });

  it('replaces every %seed% with the same generated value when not passed', () => {
    const multi = JSON.stringify({
      '3': { class_type: 'KSampler', inputs: { seed: '%seed%', text: '%prompt%' } },
      '7': { class_type: 'RandomNoise', inputs: { noise_seed: '%seed%' } },
    });
    const workflow = renderWorkflowTemplate(multi, { prompt: '1girl' });
    const a = (workflow['3'] as { inputs: { seed: unknown } }).inputs.seed;
    const b = (workflow['7'] as { inputs: { noise_seed: unknown } }).inputs.noise_seed;
    expect(a).toBeTypeOf('number');
    expect(a).toBe(b);
  });
});

describe('renderWorkflowTemplate with %nl%', () => {
  it('writes nl only into explicit %nl% placeholders, never into %prompt%', () => {
    const template = JSON.stringify({
      '3': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' } },
      '5': { class_type: 'CLIPTextEncode', inputs: { text: '%nl%' } },
    });
    const workflow = renderWorkflowTemplate(template, { prompt: '1girl', nl: 'A girl.' });
    expect((workflow['3'] as { inputs: { text: unknown } }).inputs.text).toBe('1girl');
    expect((workflow['5'] as { inputs: { text: unknown } }).inputs.text).toBe('A girl.');
  });

  it('substitutes an empty string for %nl% when nl is absent', () => {
    const template = JSON.stringify({
      '5': { class_type: 'CLIPTextEncode', inputs: { text: 'caption: %nl%', prompt: '%prompt%' } },
    });
    const workflow = renderWorkflowTemplate(template, { prompt: '1girl' });
    expect((workflow['5'] as { inputs: { text: unknown } }).inputs.text).toBe('caption: ');
  });
});

import { describe, expect, test } from '@jest/globals';

import {
  getFallbackReasoningOptions,
  REASONING_TOGGLE,
} from '@kilocode/web-shared/lib/ai-gateway/providers/reasoning-options';

describe('getFallbackReasoningOptions', () => {
  test.each([
    'google/gemma-4-26b-a4b-it',
    'vendor/longcat-preview',
    'poolside/laguna-s-2.1:free',
    'inclusionai/ling-3.1-flash',
    'minimax/minimax-m3',
    'xiaomi/mimo-v2.6-pro',
    'mistralai/mistral-medium-4',
  ])('returns a toggle for %s', model => {
    expect(getFallbackReasoningOptions(model)).toBe(REASONING_TOGGLE);
  });

  test.each([
    ['anthropic/claude-opus-5', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['deepseek/deepseek-v4', ['none', 'low', 'high', 'max']],
    ['google/gemini-3.1-pro-preview', ['minimal', 'low', 'medium', 'high']],
    ['z-ai/glm-5.2', ['none', 'high', 'xhigh']],
    ['xai/grok-4.5', ['low', 'medium', 'high']],
    ['moonshotai/kimi-k3', ['low', 'high', 'max']],
    ['inception/mercury-2', ['none', 'low', 'medium', 'high']],
    ['meta/muse-1', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']],
    ['nvidia/nemotron-3-super-120b-a12b:free', ['none', 'medium', 'high']],
    ['openai/gpt-5.6-sol', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['qwen/qwen3.8', ['minimal', 'low', 'medium', 'high', 'xhigh']],
    ['stepfun/step-5-preview', ['low', 'medium', 'high']],
    ['stealth/glyph-cluster', ['low', 'medium', 'high', 'xhigh']],
    ['reflection/beam-free', ['low', 'medium', 'high', 'xhigh', 'max']],
  ])('lists %s efforts from least to most intensive', (model, values) => {
    expect(getFallbackReasoningOptions(model)).toEqual([{ type: 'effort', values }]);
  });

  test('returns nothing for unknown models', () => {
    expect(getFallbackReasoningOptions('vendor/unknown')).toBeUndefined();
  });
});

import { describe, expect, test } from '@jest/globals';

import {
  getFallbackModelVariants,
  REASONING_VARIANTS_BINARY,
  REASONING_VARIANTS_NONE_MEDIUM_HIGH,
} from '@/lib/ai-gateway/providers/variants';

describe('getFallbackModelVariants', () => {
  test.each(['google/gemma-4-26b-a4b-it', 'vendor/longcat-preview', 'poolside/laguna-s-2.1:free'])(
    'returns binary variants for %s',
    model => {
      expect(getFallbackModelVariants(model)).toBe(REASONING_VARIANTS_BINARY);
    }
  );

  test('returns the latest Nemotron family variants', () => {
    expect(getFallbackModelVariants('nvidia/nemotron-3-super-120b-a12b:free')).toBe(
      REASONING_VARIANTS_NONE_MEDIUM_HIGH
    );
  });

  test('uses max reasoning effort for the Claude max variant', () => {
    expect(getFallbackModelVariants('anthropic/claude-opus-5')).toMatchObject({
      max: { reasoning: { enabled: true, effort: 'max' }, verbosity: 'max' },
    });
  });

  test.each([
    ['anthropic/claude-opus-5', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['deepseek/deepseek-v4', ['none', 'low', 'high', 'max']],
    ['google/gemini-3.1-pro-preview', ['minimal', 'low', 'medium', 'high']],
    ['z-ai/glm-5.2', ['none', 'high', 'xhigh']],
    ['xai/grok-4.5', ['low', 'medium', 'high']],
    ['moonshotai/kimi-k3', ['low', 'high', 'max']],
    ['inception/mercury-2', ['instant', 'low', 'medium', 'high']],
    ['meta/muse-1', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']],
    ['nvidia/nemotron-3-super-120b-a12b:free', ['none', 'medium', 'high']],
    ['openai/gpt-5.6-sol', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['qwen/qwen3.8', ['minimal', 'low', 'medium', 'high', 'xhigh']],
    ['stepfun/step-3.7-flash', ['low', 'medium', 'high']],
  ])('orders fallback variants from least to most intensive for %s', (model, expected) => {
    expect(Object.keys(getFallbackModelVariants(model) ?? {})).toEqual(expected);
  });
});

import { describe, expect, test } from '@jest/globals';
import type { OpenCodeSettings } from '@kilocode/db/schema-types';
import {
  getReasoningOptions,
  withReasoningOptions,
} from '@kilocode/web-shared/lib/ai-gateway/providers/reasoning-options';
import {
  getFallbackModelVariants,
  REASONING_VARIANTS_BINARY,
  REASONING_VARIANTS_INSTANT_LOW_MEDIUM_HIGH,
  REASONING_VARIANTS_THINKING_ONLY,
} from '@kilocode/web-shared/lib/ai-gateway/providers/variants';

describe('getReasoningOptions', () => {
  test.each([
    ['anthropic/claude-sonnet-4.6', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['openai/gpt-5.5', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['google/gemini-3.1-pro-preview', ['minimal', 'low', 'medium', 'high']],
    ['deepseek/deepseek-v4', ['none', 'low', 'high', 'max']],
    ['z-ai/glm-5.2', ['none', 'high', 'xhigh']],
    ['moonshotai/kimi-k3', ['low', 'high', 'max']],
    ['meta/muse-1', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']],
    ['qwen/qwen3.8', ['minimal', 'low', 'medium', 'high', 'xhigh']],
  ])('derives one effort entry from the %s fallback variants', (model, values) => {
    expect(getReasoningOptions(getFallbackModelVariants(model))).toEqual([
      { type: 'effort', values },
    ]);
  });

  test('derives a toggle from instant/thinking variants', () => {
    expect(getReasoningOptions(REASONING_VARIANTS_BINARY)).toEqual([{ type: 'toggle' }]);
    expect(getReasoningOptions(getFallbackModelVariants('minimax/minimax-m3'))).toEqual([
      { type: 'toggle' },
    ]);
  });

  test('derives a toggle from none/thinking variants', () => {
    expect(
      getReasoningOptions({
        none: { reasoning: { enabled: false, effort: 'none' } },
        thinking: { reasoning: { enabled: true, effort: 'high' } },
      })
    ).toEqual([{ type: 'toggle' }]);
  });

  test('does not offer turning off reasoning that is mandatory', () => {
    expect(getReasoningOptions(REASONING_VARIANTS_THINKING_ONLY)).toEqual([
      { type: 'effort', values: ['high'] },
    ]);
  });

  test('maps a disabled instant variant to the none effort', () => {
    expect(getReasoningOptions(REASONING_VARIANTS_INSTANT_LOW_MEDIUM_HIGH)).toEqual([
      { type: 'effort', values: ['none', 'low', 'medium', 'high'] },
    ]);
  });

  test('keeps a none effort derived from OpenRouter efforts as an effort value', () => {
    expect(
      getReasoningOptions({
        none: { reasoning: { enabled: false, effort: 'none' } },
        high: { reasoning: { enabled: true, effort: 'high' } },
      })
    ).toEqual([{ type: 'effort', values: ['none', 'high'] }]);
  });

  test('orders effort values from least to most intensive', () => {
    expect(
      getReasoningOptions({
        max: { reasoning: { enabled: true, effort: 'max' } },
        low: { reasoning: { enabled: true, effort: 'low' } },
        none: { reasoning: { enabled: false, effort: 'none' } },
        xhigh: { reasoning: { enabled: true, effort: 'xhigh' } },
      })
    ).toEqual([{ type: 'effort', values: ['none', 'low', 'xhigh', 'max'] }]);
  });

  test('uses the requested effort rather than the variant name', () => {
    expect(
      getReasoningOptions({
        fast: { reasoning: { enabled: true, effort: 'low' } },
        curated: { reasoning: { enabled: true, effort: 'high' } },
      })
    ).toEqual([{ type: 'effort', values: ['low', 'high'] }]);
  });

  test('omits options when there are no variants', () => {
    expect(getReasoningOptions(undefined)).toBeUndefined();
    expect(getReasoningOptions({})).toBeUndefined();
  });

  test('omits options when a variant has no expressible effort', () => {
    expect(
      getReasoningOptions({
        low: { reasoning: { enabled: true, effort: 'low' } },
        terse: { verbosity: 'low' },
      })
    ).toBeUndefined();
  });
});

describe('withReasoningOptions', () => {
  test('adds reasoning options without touching the variants', () => {
    const settings = {
      ai_sdk_provider: 'anthropic',
      variants: getFallbackModelVariants('anthropic/claude-sonnet-4.6'),
    } satisfies OpenCodeSettings;
    const serializedVariants = JSON.stringify(settings.variants);

    const result = withReasoningOptions(settings);

    expect(result.variants).toBe(settings.variants);
    expect(JSON.stringify(result.variants)).toBe(serializedVariants);
    expect(result).toEqual({
      ai_sdk_provider: 'anthropic',
      variants: settings.variants,
      reasoning_options: [
        { type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
      ],
    });
  });

  test('leaves settings without variants unchanged', () => {
    const settings = { ai_sdk_provider: 'anthropic', prompt: 'anthropic' } as const;

    expect(withReasoningOptions(settings)).toBe(settings);
  });
});

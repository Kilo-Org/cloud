import { describe, expect, test } from '@jest/globals';
import type { OpenCodeSettings, ReasoningEffort } from '@kilocode/db/schema-types';
import {
  toLegacyVariants,
  withLegacyVariants,
} from '@kilocode/web-shared/lib/ai-gateway/providers/legacy-variants';

const off = { reasoning: { enabled: false, effort: 'none' } };
const on = (effort: ReasoningEffort) => ({ reasoning: { enabled: true, effort } });

describe('toLegacyVariants', () => {
  test('keys effort variants by effort, in the given order', () => {
    expect(
      JSON.stringify(
        toLegacyVariants([{ type: 'effort', values: ['none', 'low', 'high', 'max'] }], 'openai')
      )
    ).toBe(JSON.stringify({ none: off, low: on('low'), high: on('high'), max: on('max') }));
  });

  test('adds verbosity for Anthropic models', () => {
    expect(
      JSON.stringify(
        toLegacyVariants(
          [{ type: 'effort', values: ['none', 'minimal', 'low', 'max'] }],
          'anthropic'
        )
      )
    ).toBe(
      JSON.stringify({
        none: off,
        minimal: on('minimal'),
        low: { ...on('low'), verbosity: 'low' },
        max: { ...on('max'), verbosity: 'max' },
      })
    );
  });

  test('maps a toggle to instant and thinking variants without verbosity', () => {
    expect(toLegacyVariants([{ type: 'toggle' }], 'anthropic')).toStrictEqual({
      instant: off,
      thinking: on('high'),
    });
  });

  test('maps always-on reasoning to a single thinking variant', () => {
    expect(toLegacyVariants([], undefined)).toStrictEqual({ thinking: on('high') });
  });

  test('adds a none variant when a toggle accompanies efforts without none', () => {
    expect(
      Object.keys(
        toLegacyVariants(
          [{ type: 'toggle' }, { type: 'effort', values: ['high', 'max'] }],
          undefined
        ) ?? {}
      )
    ).toEqual(['none', 'high', 'max']);
  });

  test('skips efforts the gateway cannot send', () => {
    expect(
      toLegacyVariants([{ type: 'effort', values: [null, 'default', 'low', 'low'] }], undefined)
    ).toStrictEqual({ low: on('low') });
    expect(toLegacyVariants([{ type: 'effort', values: ['default'] }], undefined)).toBeUndefined();
  });

  test('returns nothing without reasoning options', () => {
    expect(toLegacyVariants(undefined, 'anthropic')).toBeUndefined();
  });
});

describe('withLegacyVariants', () => {
  test('keeps explicit variants', () => {
    const settings: OpenCodeSettings = {
      variants: { curated: on('high') },
      reasoning_options: [{ type: 'toggle' }],
    };

    expect(withLegacyVariants(settings)).toBe(settings);
  });

  test('derives variants from reasoning options', () => {
    expect(withLegacyVariants({ reasoning_options: [{ type: 'toggle' }] })).toStrictEqual({
      reasoning_options: [{ type: 'toggle' }],
      variants: { instant: off, thinking: on('high') },
    });
  });

  test('leaves settings without reasoning options unchanged', () => {
    const settings = { ai_sdk_provider: 'anthropic' as const, prompt: 'anthropic' as const };

    expect(withLegacyVariants(settings)).toBe(settings);
  });
});

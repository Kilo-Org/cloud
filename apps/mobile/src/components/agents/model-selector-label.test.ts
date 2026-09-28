import { describe, expect, it } from 'vitest';

import { resolveModelSelectorLabel } from './model-selector-label';

const FALLBACK = 'Model';

describe('resolveModelSelectorLabel', () => {
  it('uses the matched catalog option name', () => {
    expect(
      resolveModelSelectorLabel({
        selectedName: 'DeepSeek V4 Flash 0731',
        value: 'deepseek/deepseek-v4-flash-0731',
        providerAware: false,
        fallbackLabel: FALLBACK,
      })
    ).toBe('DeepSeek V4 Flash 0731');
  });

  it('strips the vendor prefix from an unmatched stored model reference', () => {
    // The chip used to print this raw string verbatim (explorer
    // session-typed-kb-up): it repeated the vendor as
    // `DeepSeek: DeepSeek V4 Flash 0731`.
    expect(
      resolveModelSelectorLabel({
        selectedName: undefined,
        value: 'DeepSeek: DeepSeek V4 Flash 0731',
        providerAware: false,
        fallbackLabel: FALLBACK,
      })
    ).toBe('DeepSeek V4 Flash 0731');
  });

  it('keeps an unmatched value that carries no vendor prefix', () => {
    expect(
      resolveModelSelectorLabel({
        selectedName: undefined,
        value: 'custom-model-id',
        providerAware: false,
        fallbackLabel: FALLBACK,
      })
    ).toBe('custom-model-id');
  });

  it('falls back to the generic label when the value is empty', () => {
    expect(
      resolveModelSelectorLabel({
        selectedName: undefined,
        value: '',
        providerAware: false,
        fallbackLabel: FALLBACK,
      })
    ).toBe(FALLBACK);
  });

  it('falls back to the generic label for a provider-aware catalog miss', () => {
    expect(
      resolveModelSelectorLabel({
        selectedName: undefined,
        value: 'DeepSeek: DeepSeek V4 Flash 0731',
        providerAware: true,
        fallbackLabel: FALLBACK,
      })
    ).toBe(FALLBACK);
  });
});

import { describe, expect, it } from 'vitest';

import { resolveModelSelectorLabel } from './model-selector-label';

const UNKNOWN = 'Unknown';
const NOT_SELECTED = 'Not selected';

describe('resolveModelSelectorLabel', () => {
  it('uses the matched catalog option name', () => {
    expect(
      resolveModelSelectorLabel({
        selectedName: 'DeepSeek V4 Flash 0731',
        value: 'deepseek/deepseek-v4-flash-0731',
        providerAware: false,
        unknownLabel: UNKNOWN,
        notSelectedLabel: NOT_SELECTED,
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
        unknownLabel: UNKNOWN,
        notSelectedLabel: NOT_SELECTED,
      })
    ).toBe('DeepSeek V4 Flash 0731');
  });

  it('shows the readable segment of an unmatched model reference', () => {
    // The session composer chip read `deepseek/deepseek-v4.1-flash-1017` while
    // the picker named the same model `DeepSeek V4.1 Flash 1017`.
    expect(
      resolveModelSelectorLabel({
        selectedName: undefined,
        value: 'deepseek/deepseek-v4.1-flash-1017',
        providerAware: false,
        unknownLabel: UNKNOWN,
        notSelectedLabel: NOT_SELECTED,
      })
    ).toBe('deepseek v4.1 flash 1017');
  });

  it('keeps an unmatched value that carries no vendor prefix', () => {
    expect(
      resolveModelSelectorLabel({
        selectedName: undefined,
        value: 'custom-model-id',
        providerAware: false,
        unknownLabel: UNKNOWN,
        notSelectedLabel: NOT_SELECTED,
      })
    ).toBe('custom-model-id');
  });

  it('says no model is chosen when the value is empty, instead of repeating the field label', () => {
    expect(
      resolveModelSelectorLabel({
        selectedName: undefined,
        value: '',
        providerAware: false,
        unknownLabel: UNKNOWN,
        notSelectedLabel: NOT_SELECTED,
      })
    ).toBe(NOT_SELECTED);
  });

  it('reads a provider-aware catalog miss as unknown, not the generic field label', () => {
    expect(
      resolveModelSelectorLabel({
        selectedName: undefined,
        value: 'DeepSeek: DeepSeek V4 Flash 0731',
        providerAware: true,
        unknownLabel: UNKNOWN,
        notSelectedLabel: NOT_SELECTED,
      })
    ).toBe(UNKNOWN);
  });
});

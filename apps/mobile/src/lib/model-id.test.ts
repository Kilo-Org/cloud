import { describe, expect, it } from 'vitest';

import { autoModelNameKey, formatModelName, stripModelPrefix } from './model-id';

describe('autoModelNameKey', () => {
  it('names a catalog key for every Kilo auto tier the gateway exposes', () => {
    expect(autoModelNameKey('kilo-auto/efficient')).toBe('common.autoModelEfficient');
    expect(autoModelNameKey('kilo-auto/balanced')).toBe('common.autoModelBalanced');
    expect(autoModelNameKey('kilo-auto/frontier')).toBe('common.autoModelFrontier');
    expect(autoModelNameKey('kilo-auto/free')).toBe('common.autoModelFree');
    expect(autoModelNameKey('kilo-auto/small')).toBe('common.autoModelSmall');
  });

  it('has no key for a vendor model, so its gateway name is kept', () => {
    expect(autoModelNameKey('deepseek/deepseek-v4.1-flash')).toBeUndefined();
    expect(autoModelNameKey('kilo-auto/unknown-tier')).toBeUndefined();
    expect(autoModelNameKey('')).toBeUndefined();
    expect(autoModelNameKey(null)).toBeUndefined();
    expect(autoModelNameKey(undefined)).toBeUndefined();
  });
});

describe('formatModelName', () => {
  it('shortens the auto tiers and passes anything else through', () => {
    expect(formatModelName(stripModelPrefix('kilocode/kilo-auto/balanced'))).toBe('Balanced');
    expect(formatModelName('kilo-auto/frontier')).toBe('Frontier');
    expect(formatModelName('deepseek/deepseek-v4.1-flash')).toBe('deepseek/deepseek-v4.1-flash');
  });
});

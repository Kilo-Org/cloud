import { describe, expect, it } from 'vitest';

import { formatModelName, stripModelPrefix } from './model-id';

describe('formatModelName', () => {
  it('shortens the auto tiers and passes anything else through', () => {
    expect(formatModelName(stripModelPrefix('kilocode/kilo-auto/balanced'))).toBe('Balanced');
    expect(formatModelName('kilo-auto/frontier')).toBe('Frontier');
    expect(formatModelName('deepseek/deepseek-v4.1-flash')).toBe('deepseek/deepseek-v4.1-flash');
  });
});

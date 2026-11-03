import { describe, expect, it } from 'vitest';

import { resolveAlphaColor } from './theme-color';

describe('resolveAlphaColor', () => {
  it('builds an rgba stop from a six-digit hex color', () => {
    expect(resolveAlphaColor('#14130F', 0.06)).toBe('rgba(20, 19, 15, 0.06)');
    expect(resolveAlphaColor('#FFFFFF', 0)).toBe('rgba(255, 255, 255, 0)');
  });

  it('falls back to black when the color cannot be parsed', () => {
    expect(resolveAlphaColor('not-a-color', 0.06)).toBe('rgba(0, 0, 0, 0.06)');
  });
});

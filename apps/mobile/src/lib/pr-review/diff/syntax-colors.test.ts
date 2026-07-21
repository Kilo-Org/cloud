import { describe, expect, it } from 'vitest';

import { DEFAULT_TOKEN_COLOR, tokenColorFor } from './syntax-colors';

describe('tokenColorFor', () => {
  it('returns the light color for a known class in light mode', () => {
    expect(tokenColorFor('keyword', false)).toBe('#7B2CBF');
  });

  it('returns the dark color for a known class in dark mode', () => {
    expect(tokenColorFor('keyword', true)).toBe('#D8B4FE');
  });

  it('falls back to the default color for an unknown class', () => {
    expect(tokenColorFor('unknown-token', false)).toBe(DEFAULT_TOKEN_COLOR.light);
    expect(tokenColorFor('unknown-token', true)).toBe(DEFAULT_TOKEN_COLOR.dark);
  });

  it('falls back to the default color when className is null', () => {
    expect(tokenColorFor(null, false)).toBe(DEFAULT_TOKEN_COLOR.light);
    expect(tokenColorFor(null, true)).toBe(DEFAULT_TOKEN_COLOR.dark);
  });
});

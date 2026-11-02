import { describe, expect, it } from 'vitest';

import { instructionsFieldOverflows } from './code-reviewer-instructions-field';

describe('instructionsFieldOverflows', () => {
  // The field's measured height at its ten-line cap on a 420dpi device is
  // 196.19dp; its padding is 21dp, so 175dp of content fits.
  it('reports a value taller than the usable field as overflowing', () => {
    expect(instructionsFieldOverflows(1264.76, 196.19)).toBe(true);
  });

  it('keeps a value that fits the usable field', () => {
    expect(instructionsFieldOverflows(105, 196.19)).toBe(false);
  });

  it('keeps a value that exactly fills the usable field', () => {
    expect(instructionsFieldOverflows(175.19, 196.19)).toBe(false);
  });

  it('tolerates sub-point measurement noise above the fitting height', () => {
    expect(instructionsFieldOverflows(175.4, 196.19)).toBe(false);
  });
});

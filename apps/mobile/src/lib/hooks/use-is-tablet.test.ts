import { describe, expect, it } from 'vitest';

import { isTabletFromDimensions } from './is-tablet';

describe('isTabletFromDimensions', () => {
  it('reports iPad hardware as tablet regardless of dimensions', () => {
    expect(isTabletFromDimensions(320, 480, true)).toBe(true);
    expect(isTabletFromDimensions(1024, 768, true)).toBe(true);
  });

  it('reports phone-portrait dimensions (short edge < 600) as phone', () => {
    expect(isTabletFromDimensions(390, 844, false)).toBe(false);
    expect(isTabletFromDimensions(320, 568, false)).toBe(false);
  });

  it('reports phone-landscape (short edge < 600) as phone', () => {
    // A landscape phone is wider than tall but still has a short edge < 600.
    expect(isTabletFromDimensions(844, 390, false)).toBe(false);
  });

  it('reports a window with a 400-short-edge as phone', () => {
    expect(isTabletFromDimensions(600, 400, false)).toBe(false);
    expect(isTabletFromDimensions(400, 600, false)).toBe(false);
  });

  it('reports windows with a short edge >= 600 as tablet', () => {
    expect(isTabletFromDimensions(600, 1200, false)).toBe(true);
    expect(isTabletFromDimensions(1200, 600, false)).toBe(true);
    expect(isTabletFromDimensions(1024, 768, false)).toBe(true);
    expect(isTabletFromDimensions(768, 1024, false)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';

import { isNarrowLayout, NARROW_LAYOUT_WIDTH } from '@/lib/narrow-layout';

describe('isNarrowLayout', () => {
  it('is narrow below the threshold', () => {
    expect(isNarrowLayout(160)).toBe(true);
    expect(isNarrowLayout(200)).toBe(true);
    expect(isNarrowLayout(NARROW_LAYOUT_WIDTH - 1)).toBe(true);
  });

  it('keeps the side-by-side layout at the threshold and every real phone width', () => {
    expect(isNarrowLayout(NARROW_LAYOUT_WIDTH)).toBe(false);
    expect(isNarrowLayout(320)).toBe(false);
    expect(isNarrowLayout(411)).toBe(false);
  });

  it('treats an unknown width as the standard layout', () => {
    expect(isNarrowLayout(undefined)).toBe(false);
  });
});

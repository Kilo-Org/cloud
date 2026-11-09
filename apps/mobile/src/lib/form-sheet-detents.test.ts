import { describe, expect, it } from 'vitest';

import { organizationSheetDetents } from './form-sheet-detents';

describe('organizationSheetDetents', () => {
  it('offers the full detent alone in a short Android window', () => {
    expect(
      organizationSheetDetents({ platform: 'android', windowHeight: 411, fullSheetDetent: 0.94 })
    ).toEqual([0.94]);
  });

  it('keeps the half detent in a tall Android window', () => {
    expect(
      organizationSheetDetents({ platform: 'android', windowHeight: 914, fullSheetDetent: 0.97 })
    ).toEqual([0.5, 0.97]);
  });

  it('keeps both detents on iOS, whose sheets own their insets', () => {
    expect(
      organizationSheetDetents({ platform: 'ios', windowHeight: 411, fullSheetDetent: 1 })
    ).toEqual([0.5, 1]);
  });
});

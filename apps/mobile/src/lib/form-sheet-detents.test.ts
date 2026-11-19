import { describe, expect, it } from 'vitest';

import { organizationSheetDetents } from './form-sheet-detents';

describe('organizationSheetDetents', () => {
  it('offers the full detent alone in a short Android window', () => {
    expect(
      organizationSheetDetents({ platform: 'android', windowHeight: 411, fullSheetDetent: 0.94 })
    ).toEqual([0.94]);
  });

  // 914 dp sits below the 1000 dp threshold: the tallest organization form with
  // its refusal row cannot fit the half detent there, so the sheet opens at the
  // full detent alone.
  it('offers the full detent alone in a 914 dp Android window', () => {
    expect(
      organizationSheetDetents({ platform: 'android', windowHeight: 914, fullSheetDetent: 0.97 })
    ).toEqual([0.97]);
  });

  // 985 dp is just under twice the 415pt content plus the 78pt bar band (986),
  // so the half detent would still clip the refusal row.
  it('offers the full detent alone just below the doubled budget', () => {
    expect(
      organizationSheetDetents({ platform: 'android', windowHeight: 985, fullSheetDetent: 0.97 })
    ).toEqual([0.97]);
  });

  it('keeps the half detent in a window at and above the threshold', () => {
    expect(
      organizationSheetDetents({ platform: 'android', windowHeight: 1000, fullSheetDetent: 0.97 })
    ).toEqual([0.5, 0.97]);
    expect(
      organizationSheetDetents({ platform: 'android', windowHeight: 1200, fullSheetDetent: 0.97 })
    ).toEqual([0.5, 0.97]);
  });

  it('keeps both detents on iOS, whose sheets own their insets', () => {
    expect(
      organizationSheetDetents({ platform: 'ios', windowHeight: 411, fullSheetDetent: 1 })
    ).toEqual([0.5, 1]);
  });
});

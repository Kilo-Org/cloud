import { describe, expect, it } from 'vitest';

import { prMergeSheetOptions } from './merge-sheet-options';

const shared = {
  presentation: 'formSheet' as const,
  sheetAllowedDetents: [0.5, 0.94] as [number, number],
  sheetInitialDetentIndex: 'last' as const,
};

describe('prMergeSheetOptions', () => {
  it('keeps only the full detent on Android, so the Merge button cannot fall below a half sheet', () => {
    expect(prMergeSheetOptions(shared, 'android')).toEqual({
      ...shared,
      sheetAllowedDetents: [0.94],
    });
  });

  it('keeps both detents on iOS, which lays the form out at the presented detent', () => {
    expect(prMergeSheetOptions(shared, 'ios')).toEqual(shared);
  });
});

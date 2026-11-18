import { describe, expect, it } from 'vitest';

import { nativeRefreshIndicatorIsInset, rowsRefreshIndicatorParkOffset } from './refresh-indicator';

describe('nativeRefreshIndicatorIsInset', () => {
  it('reports Android as not inset, where the indicator is drawn over the first row', () => {
    expect(nativeRefreshIndicatorIsInset('android')).toBe(false);
  });

  it('reports iOS as inset inside its scroll content, so it cannot cover a row', () => {
    expect(nativeRefreshIndicatorIsInset('ios')).toBe(true);
  });
});

describe('rowsRefreshIndicatorParkOffset', () => {
  it('parks the Android indicator a whole viewport below the rows list top', () => {
    expect(rowsRefreshIndicatorParkOffset('android', 844)).toBe(844);
  });

  it('leaves iOS on the platform default, where its inset indicator is the one shown', () => {
    expect(rowsRefreshIndicatorParkOffset('ios', 844)).toBeUndefined();
  });
});

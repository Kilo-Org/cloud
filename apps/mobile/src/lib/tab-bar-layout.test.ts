import { describe, expect, it } from 'vitest';

import { getTabBarOverlayHeight } from '@/lib/tab-bar-layout';

describe('getTabBarOverlayHeight', () => {
  it('includes the bottom safe area on iOS', () => {
    expect(getTabBarOverlayHeight(34, 'ios')).toBe(84);
  });

  it('includes the Android extra padding used by the tab bar', () => {
    expect(getTabBarOverlayHeight(16, 'android')).toBe(70);
  });

  it('ignores negative insets', () => {
    expect(getTabBarOverlayHeight(-1, 'ios')).toBe(50);
  });
});

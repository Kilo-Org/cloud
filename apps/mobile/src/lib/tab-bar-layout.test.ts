import { describe, expect, it } from 'vitest';

import { getTabBarOverlayHeight, shouldHideTabBar } from '@/lib/tab-bar-layout';

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

  it('grows to preserve scaled tab labels', () => {
    expect(getTabBarOverlayHeight(34, 'ios', 3)).toBe(164);
  });
});

describe('shouldHideTabBar', () => {
  it('hides tabs for full-screen nested routes', () => {
    expect(shouldHideTabBar('/chat/sandbox-1/instance-picker')).toBe(true);
    expect(shouldHideTabBar('/security-agent/personal/filter')).toBe(true);
    expect(shouldHideTabBar('/security-agent/org-1/filter')).toBe(true);
  });

  it('keeps tabs on normal tab screens', () => {
    expect(shouldHideTabBar('/security-agent/personal')).toBe(false);
    expect(shouldHideTabBar('/security-agent/personal/findings')).toBe(false);
  });
});

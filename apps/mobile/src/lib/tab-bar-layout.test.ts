import { describe, expect, it } from 'vitest';

import {
  getEffectiveTabBarHeight,
  getTabBarIconForwardHeight,
  getTabBarIconSize,
  getTabBarOverlayHeight,
  shouldHideTabBar,
  shouldShowTabLabel,
  TAB_ICON_FORWARD_FONT_SCALE,
  TAB_LABEL_WRAP_FONT_SCALE,
  tabAccessibilityLabel,
} from '@/lib/tab-bar-layout';

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

describe('getEffectiveTabBarHeight', () => {
  it('uses the label-inclusive overlay height below the icon-forward threshold', () => {
    expect(getEffectiveTabBarHeight({ bottomInset: 34, platform: 'ios', fontScale: 1 })).toBe(
      getTabBarOverlayHeight(34, 'ios', 1)
    );
    expect(getEffectiveTabBarHeight({ bottomInset: 34, platform: 'ios', fontScale: 1.8 })).toBe(
      getTabBarOverlayHeight(34, 'ios', 1.8)
    );
  });

  it('uses the compact icon-forward height at and above the icon-forward threshold', () => {
    expect(getEffectiveTabBarHeight({ bottomInset: 34, platform: 'ios', fontScale: 2 })).toBe(
      getTabBarIconForwardHeight(34, 'ios')
    );
    expect(getEffectiveTabBarHeight({ bottomInset: 34, platform: 'ios', fontScale: 2.5 })).toBe(
      getTabBarIconForwardHeight(34, 'ios')
    );
    expect(getEffectiveTabBarHeight({ bottomInset: 34, platform: 'ios', fontScale: 3 })).toBe(
      getTabBarIconForwardHeight(34, 'ios')
    );
  });

  it('matches the rendered bar height at representative scales', () => {
    // default scale: label-inclusive bar is 84pt on an iPhone-class bottom inset
    expect(getEffectiveTabBarHeight({ bottomInset: 34, platform: 'ios', fontScale: 1 })).toBe(84);
    // large scale: icon-forward bar collapses back to 84pt (same as default scale)
    expect(getEffectiveTabBarHeight({ bottomInset: 34, platform: 'ios', fontScale: 3 })).toBe(84);
  });

  it('applies the same Android bottom padding as the overlay helpers', () => {
    // Below the icon-forward threshold the label-inclusive overlay height is used.
    expect(getEffectiveTabBarHeight({ bottomInset: 16, platform: 'android', fontScale: 1 })).toBe(
      70
    );
    expect(getEffectiveTabBarHeight({ bottomInset: 16, platform: 'android', fontScale: 1.8 })).toBe(
      82.8
    );
    // At and above the threshold the bar collapses to the icon-forward height.
    expect(getEffectiveTabBarHeight({ bottomInset: 16, platform: 'android', fontScale: 2 })).toBe(
      70
    );
    expect(getEffectiveTabBarHeight({ bottomInset: 16, platform: 'android', fontScale: 2.5 })).toBe(
      70
    );
    expect(getEffectiveTabBarHeight({ bottomInset: 16, platform: 'android', fontScale: 3 })).toBe(
      70
    );
  });
});
describe('getTabBarIconForwardHeight', () => {
  it('collapses to the base height when labels are hidden at large font scale', () => {
    expect(getTabBarIconForwardHeight(34, 'ios')).toBe(84);
    expect(getTabBarIconForwardHeight(16, 'android')).toBe(70);
  });

  it('ignores negative insets', () => {
    expect(getTabBarIconForwardHeight(-1, 'ios')).toBe(50);
  });
});

describe('getTabBarIconSize', () => {
  it('returns the base size at the default font scale', () => {
    expect(getTabBarIconSize(1)).toBe(22);
  });

  it('grows with font scale but stays bounded', () => {
    expect(getTabBarIconSize(1.2)).toBe(26);
    expect(getTabBarIconSize(1.5)).toBe(26);
    expect(getTabBarIconSize(3)).toBe(26);
  });

  it('never drops below the base size for very small font scales', () => {
    expect(getTabBarIconSize(0.85)).toBe(22);
  });
});

describe('shouldShowTabLabel', () => {
  it('keeps the label below the icon-forward threshold', () => {
    expect(shouldShowTabLabel(1)).toBe(true);
    expect(shouldShowTabLabel(TAB_LABEL_WRAP_FONT_SCALE)).toBe(true);
  });

  it('hides the label at and above the icon-forward threshold', () => {
    expect(shouldShowTabLabel(TAB_ICON_FORWARD_FONT_SCALE)).toBe(false);
    expect(shouldShowTabLabel(2.5)).toBe(false);
    expect(shouldShowTabLabel(3)).toBe(false);
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

describe('tabAccessibilityLabel', () => {
  it('reports the position and total for four tabs', () => {
    expect(tabAccessibilityLabel('Home', 1, 4)).toBe('Home, tab, 1 of 4');
  });

  it('reports the position and total for three tabs', () => {
    expect(tabAccessibilityLabel('Profile', 3, 3)).toBe('Profile, tab, 3 of 3');
  });
});

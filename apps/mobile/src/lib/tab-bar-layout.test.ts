// eslint-disable-next-line import/no-nodejs-modules -- vitest-only parity check, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only parity check, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import {
  getEffectiveTabBarHeight,
  getTabBarHorizontalInset,
  getTabBarIconForwardHeight,
  getTabBarIconSize,
  getTabBarOverlayHeight,
  shouldHideTabBar,
  shouldShowTabLabel,
  TAB_ICON_FORWARD_FONT_SCALE,
  TAB_LABEL_WRAP_FONT_SCALE,
  tabAccessibilityLabel,
  tabBarPosition,
  tabLabelFits,
  tabLabelNumberOfLines,
  tabLabelWidth,
  visibleTabCount,
} from '@/lib/tab-bar-layout';

const LAYOUT_SOURCE = readFileSync(
  fileURLToPath(new URL('tab-bar-layout.ts', import.meta.url)),
  'utf8'
);
const LABEL_SOURCE = readFileSync(
  fileURLToPath(new URL('../components/tab-bar-label.tsx', import.meta.url)),
  'utf8'
);

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

  it('honours a caller-supplied label decision at the default font scale', () => {
    expect(
      getEffectiveTabBarHeight({
        bottomInset: 16,
        platform: 'android',
        fontScale: 1,
        showLabel: false,
      })
    ).toBe(getTabBarIconForwardHeight(16, 'android'));
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

describe('getTabBarHorizontalInset', () => {
  it('pads each side by its landscape safe-area inset', () => {
    expect(getTabBarHorizontalInset({ left: 47, right: 59 })).toEqual({
      paddingLeft: 47,
      paddingRight: 59,
    });
  });

  it('collapses to a no-op in portrait with zero insets', () => {
    expect(getTabBarHorizontalInset({ left: 0, right: 0 })).toEqual({
      paddingLeft: 0,
      paddingRight: 0,
    });
  });

  it('ignores negative insets', () => {
    expect(getTabBarHorizontalInset({ left: -1, right: -1 })).toEqual({
      paddingLeft: 0,
      paddingRight: 0,
    });
  });

  it('treats missing insets as zero', () => {
    expect(getTabBarHorizontalInset({})).toEqual({ paddingLeft: 0, paddingRight: 0 });
  });
});

describe('tabLabelWidth', () => {
  it('measures a single unbroken word at the tab label size', () => {
    // "Profile" is 7 glyphs at (0.6em x 11) + 0.2 tracking = 47.6
    expect(tabLabelWidth('Profile')).toBeCloseTo(47.6, 5);
  });

  it('measures the widest whitespace-separated line of a wrapped label', () => {
    expect(tabLabelWidth('Kilo\nClaw')).toBeCloseTo(tabLabelWidth('Kilo'), 5);
    expect(tabLabelWidth('Bogga shakhsiga')).toBeCloseTo(9 * (0.6 * 11 + 0.2), 5);
  });

  it('scales the glyph advance (not the tracking) with the system font scale', () => {
    expect(tabLabelWidth('Profile', 2)).toBeCloseTo(7 * (0.6 * 11 * 2 + 0.2), 5);
  });

  it('counts CJK/Kana/Hangul glyphs as one em wide', () => {
    expect(tabLabelWidth('設定')).toBeCloseTo(2 * (11 + 0.2), 5);
  });
});

describe('tabLabelFits', () => {
  it('rejects a label wider than its tab minus the item padding', () => {
    // 160dp / 3 tabs = 53.3dp box, less 10dp padding = 43.3dp for a 47.6dp word
    expect(tabLabelFits('Profile', 160 / 3)).toBe(false);
  });

  it('accepts the same label on a normal phone width', () => {
    expect(tabLabelFits('Profile', 360 / 3)).toBe(true);
  });

  it('uses the widest line, so a space-separated label can still fit', () => {
    expect(tabLabelFits('Kilo Claw', 160 / 3)).toBe(true);
    expect(tabLabelFits('Bogga shakhsiga', 160 / 3)).toBe(false);
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

  it('drops the labels when any label is too wide for its tab', () => {
    // Reported geometry: 160dp / 5 tabs = 32dp per tab, 22dp for the label
    expect(shouldShowTabLabel(1, 160 / 5, ['Home', 'KiloClaw', 'Agents', 'Chat', 'Profile'])).toBe(
      false
    );
  });

  it('keeps the labels when every label fits its tab', () => {
    expect(shouldShowTabLabel(1, 360 / 5, ['Home', 'KiloClaw', 'Agents', 'Chat', 'Profile'])).toBe(
      true
    );
  });

  it('keeps the width rule from overriding the font-scale rule', () => {
    expect(shouldShowTabLabel(2, 160 / 5, ['Home'])).toBe(false);
  });
});

describe('tabLabelNumberOfLines', () => {
  it('keeps a word that fits its tab on one line', () => {
    expect(tabLabelNumberOfLines('Home')).toBe(1);
  });

  it('keeps a word wider than a narrow tab on one line so it truncates instead of breaking mid-word', () => {
    expect(tabLabelNumberOfLines('Conversazioni')).toBe(1);
  });

  it('keeps the two lines for copy that carries its own break', () => {
    expect(tabLabelNumberOfLines(i18n.t('tabs.kiloclawWrapped'))).toBe(2);
    expect(tabLabelNumberOfLines('Kilo\nClaw')).toBe(2);
  });
});

describe('mirrored tab label metrics', () => {
  // The metrics at the top of this module are copied from the label
  // component's style, so the "keep these in step" pointer must name the file
  // that actually owns that style, and the copied tokens must still match it.
  it('points at the component that owns the tab label style', () => {
    expect(LAYOUT_SOURCE).toContain('apps/mobile/src/components/tab-bar-label.tsx');
    expect(LABEL_SOURCE).toContain('export function TabBarLabel');
  });

  it('mirrors the component font size and tracking in the width estimate', () => {
    // JetBrains Mono advances 0.6em per glyph; the label adds 0.2px tracking.
    // `tabLabelWidth` must use the same 11px/0.2px the component's class sets,
    // and the component must render one line via `tabLabelNumberOfLines`.
    expect(LABEL_SOURCE).toContain(
      'font-mono-medium text-[11px] leading-4 uppercase tracking-[0.2px]'
    );
    expect(LABEL_SOURCE).toContain('numberOfLines={tabLabelNumberOfLines(label)}');
    expect(tabLabelWidth('A')).toBeCloseTo(0.6 * 11 + 0.2);
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

describe('visibleTabCount', () => {
  it('counts three base tabs when both flagged tabs are hidden', () => {
    expect(visibleTabCount(false, false)).toBe(3);
  });

  it('adds the KiloClaw tab only', () => {
    expect(visibleTabCount(true, false)).toBe(4);
  });

  it('adds the Chat tab only', () => {
    expect(visibleTabCount(false, true)).toBe(4);
  });

  it('adds both flagged tabs', () => {
    expect(visibleTabCount(true, true)).toBe(5);
  });
});

describe('tabBarPosition', () => {
  const noFlags = { showKiloClaw: false, showQuickChat: false };
  const kiloclawOnly = { showKiloClaw: true, showQuickChat: false };
  const chatOnly = { showKiloClaw: false, showQuickChat: true };
  const both = { showKiloClaw: true, showQuickChat: true };

  it('positions Home at 1 in every combination', () => {
    expect(tabBarPosition('home', noFlags)).toBe(1);
    expect(tabBarPosition('home', both)).toBe(1);
  });

  it('returns null for a hidden KiloClaw tab', () => {
    expect(tabBarPosition('kiloclaw', noFlags)).toBeNull();
    expect(tabBarPosition('kiloclaw', chatOnly)).toBeNull();
  });

  it('positions KiloClaw at 2 when shown', () => {
    expect(tabBarPosition('kiloclaw', kiloclawOnly)).toBe(2);
    expect(tabBarPosition('kiloclaw', both)).toBe(2);
  });

  it('positions Agents after KiloClaw', () => {
    expect(tabBarPosition('agents', noFlags)).toBe(2);
    expect(tabBarPosition('agents', kiloclawOnly)).toBe(3);
  });

  it('returns null for a hidden Chat tab and positions it after Agents when shown', () => {
    expect(tabBarPosition('chat', noFlags)).toBeNull();
    expect(tabBarPosition('chat', kiloclawOnly)).toBeNull();
    expect(tabBarPosition('chat', chatOnly)).toBe(3);
    expect(tabBarPosition('chat', both)).toBe(4);
  });

  it('positions Profile last in every combination', () => {
    expect(tabBarPosition('profile', noFlags)).toBe(3);
    expect(tabBarPosition('profile', kiloclawOnly)).toBe(4);
    expect(tabBarPosition('profile', chatOnly)).toBe(4);
    expect(tabBarPosition('profile', both)).toBe(5);
  });
});

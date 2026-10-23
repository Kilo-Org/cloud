/* eslint-disable max-lines -- the bar-height, label-width and label-fit suites all read one module and the same source-parity text; splitting them would duplicate that harness */
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
  TAB_LABEL_MINIMUM_FONT_SCALE,
  TAB_LABEL_WRAP_FONT_SCALE,
  tabAccessibilityLabel,
  tabBarPosition,
  tabLabelFits,
  tabLabelLineCount,
  tabLabelLines,
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
    expect(getTabBarOverlayHeight({ bottomInset: 34, platform: 'ios' })).toBe(84);
  });

  it('includes the Android extra padding used by the tab bar', () => {
    expect(getTabBarOverlayHeight({ bottomInset: 16, platform: 'android' })).toBe(70);
  });

  it('ignores negative insets', () => {
    expect(getTabBarOverlayHeight({ bottomInset: -1, platform: 'ios' })).toBe(50);
  });

  it('grows to preserve scaled tab labels', () => {
    expect(getTabBarOverlayHeight({ bottomInset: 34, platform: 'ios', fontScale: 3 })).toBe(164);
  });
});

describe('tabLabelLineCount', () => {
  it('reserves one line below the wrap threshold', () => {
    expect(tabLabelLineCount(1)).toBe(1);
    expect(tabLabelLineCount(TAB_LABEL_WRAP_FONT_SCALE)).toBe(1);
  });

  it('reserves the second line above the wrap threshold', () => {
    expect(tabLabelLineCount(TAB_LABEL_WRAP_FONT_SCALE + 0.01)).toBe(2);
    expect(tabLabelLineCount(3)).toBe(2);
  });

  it('agrees with the height the bar reserves', () => {
    // The bar reserves one label line below the wrap threshold and two above
    // it; the label is never allowed to render more lines than that.
    expect(
      getTabBarOverlayHeight({ bottomInset: 0, platform: 'android', fontScale: 1 })
    ).toBeCloseTo(34 + 16 * 1 * tabLabelLineCount(1) + 4);
    expect(
      getTabBarOverlayHeight({ bottomInset: 0, platform: 'android', fontScale: 1.9 })
    ).toBeCloseTo(34 + 16 * 1.9 * tabLabelLineCount(1.9) + 4);
  });
});

describe('getEffectiveTabBarHeight', () => {
  it('uses the label-inclusive overlay height below the icon-forward threshold', () => {
    expect(getEffectiveTabBarHeight({ bottomInset: 34, platform: 'ios', fontScale: 1 })).toBe(
      getTabBarOverlayHeight({ bottomInset: 34, platform: 'ios', fontScale: 1 })
    );
    expect(getEffectiveTabBarHeight({ bottomInset: 34, platform: 'ios', fontScale: 1.8 })).toBe(
      getTabBarOverlayHeight({ bottomInset: 34, platform: 'ios', fontScale: 1.8 })
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

  it('measures a wrapped label line by line, but a space-separated label as one line', () => {
    // Only the explicit break splits the label into two lines; a plain space
    // stays on the single line the renderer lays out.
    expect(tabLabelWidth('Kilo\nClaw')).toBeCloseTo(tabLabelWidth('Kilo'), 5);
    expect(tabLabelWidth('Bogga shakhsiga')).toBeCloseTo(15 * (0.6 * 11 + 0.2), 5);
  });

  it('counts a plain space as part of the single rendered line', () => {
    // "Kilo Claw" is one line of 9 glyphs, not the 4-glyph widest word.
    expect(tabLabelWidth('Kilo Claw')).toBeCloseTo(9 * (0.6 * 11 + 0.2), 5);
  });

  it('scales the glyph advance (not the tracking) with the system font scale', () => {
    expect(tabLabelWidth('Profile', 2)).toBeCloseTo(7 * (0.6 * 11 * 2 + 0.2), 5);
  });

  it('counts CJK/Kana/Hangul glyphs as one em wide', () => {
    expect(tabLabelWidth('設定')).toBeCloseTo(2 * (11 + 0.2), 5);
  });

  it('counts RTL-script glyphs at the fallback-font advance, not the mono advance', () => {
    // Arabic and Hebrew render in the system fallback font (`Text` drops the
    // mono family for RTL-script copy, both scripts included), whose glyphs are
    // far narrower than JetBrains Mono's 0.6em. Measuring them at the mono
    // advance over-estimated the width until the width rule dropped every
    // Arabic label at phone widths.
    expect(tabLabelWidth('الرئيسية')).toBeCloseTo(8 * (0.55 * 11 + 0.2), 5);
    expect(tabLabelWidth('הגדרות')).toBeCloseTo(6 * (0.55 * 11 + 0.2), 5);
    expect(tabLabelWidth('الملف الشخصي')).toBeCloseTo(11 * (0.55 * 11 + 0.2) + (0.6 * 11 + 0.2), 5);
  });

  it('measures a mixed-script label per glyph', () => {
    // "Home" (4 mono glyphs) + a space + "الرئيسية" (8 RTL-script glyphs): the
    // space between the scripts stays on the one line at the mono advance.
    expect(tabLabelWidth('Home الرئيسية')).toBeCloseTo(
      5 * (0.6 * 11 + 0.2) + 8 * (0.55 * 11 + 0.2),
      5
    );
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

  it('rejects a space-separated label that overflows its single rendered line', () => {
    // "KILO CLAW" renders on one 9-glyph line (61.2dp), so it cannot fit the
    // 43.3dp label box even though either word alone would.
    expect(tabLabelFits('Kilo Claw', 160 / 3)).toBe(false);
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

  it('never hides the labels because of the window width', () => {
    // The reported bar: 160dp over five tabs leaves a 22dp box that no label
    // fits, and the old width rule dropped every label. Width now decides how
    // many lines a label takes, never whether the row exists.
    expect(shouldShowTabLabel(1)).toBe(true);
  });
});

describe('tabLabelLines', () => {
  it('keeps a label that fits its tab on one line', () => {
    expect(tabLabelLines('Profile', 360 / 3)).toBe(1);
    expect(tabLabelLines('Home', 360 / 5)).toBe(1);
  });

  it('gives a space-separated label a second line when it does not fit', () => {
    expect(tabLabelLines('الملف الشخصي', 360 / 5)).toBe(2);
    expect(tabLabelLines('Bogga shakhsiga', 160 / 3)).toBe(2);
    expect(tabLabelLines('Quick Chat', 160 / 3)).toBe(2);
  });

  it('keeps a single word on one line so it shrinks instead of breaking mid-word', () => {
    expect(tabLabelLines('Conversazioni', 60)).toBe(1);
    expect(tabLabelLines('設定', 20)).toBe(1);
  });

  it('keeps the two lines of copy that carries its own break', () => {
    expect(tabLabelLines('Kilo\nClaw', 400)).toBe(2);
  });

  it('keeps every label that fits at phone width on one line', () => {
    for (const label of ['Home', 'Agents', 'Profile', 'Chat']) {
      expect(tabLabelFits(label, 360 / 5)).toBe(true);
      expect(tabLabelLines(label, 360 / 5)).toBe(1);
    }
  });
});

describe('tab label shrink floor', () => {
  // A one-line label asks the platform to shrink it and caps the shrink at
  // TAB_LABEL_MINIMUM_FONT_SCALE on iOS (Android floors at RN's own minimum).
  // The bar no longer drops the row when the cap cannot save a label: the label
  // tail-truncates, so the row stays and the tab keeps its visible name.
  it('keeps one line for a word that cannot fit its tab even at the floor', () => {
    // Profile is 47.6dp wide; a 30dp label box would need a 0.63 shrink, below
    // the 0.75 cap, so the label tail-truncates instead of wrapping mid-word.
    expect(tabLabelWidth('Profile')).toBeGreaterThan((40 - 10) / TAB_LABEL_MINIMUM_FONT_SCALE);
    expect(tabLabelLines('Profile', 40)).toBe(1);
    for (const label of ['Conversazioni', '設定']) {
      expect(tabLabelLines(label, 20)).toBe(1);
    }
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
    // and the component renders that line count (its own break rule first).
    expect(LABEL_SOURCE).toContain(
      'font-mono-medium text-[11px] leading-4 uppercase tracking-[0.2px]'
    );
    expect(LABEL_SOURCE).toContain('numberOfLines={resolvedLines}');
    expect(tabLabelWidth('A')).toBeCloseTo(0.6 * 11 + 0.2);
  });
});

describe('shouldHideTabBar', () => {
  it('hides tabs for full-screen nested routes', () => {
    expect(shouldHideTabBar('/chat/sandbox-1/instance-picker', [])).toBe(true);
    expect(shouldHideTabBar('/security-agent/personal/filter', [])).toBe(true);
    expect(shouldHideTabBar('/security-agent/org-1/filter', [])).toBe(true);
  });

  it('keeps tabs on normal tab screens', () => {
    expect(shouldHideTabBar('/security-agent/personal', [])).toBe(false);
    expect(shouldHideTabBar('/security-agent/personal/findings', [])).toBe(false);
  });

  it('hides tabs inside a chat, whose composer sits where the bar would be', () => {
    expect(shouldHideTabBar('/abc123', ['(app)', '(tabs)', '(4_chat)', '[id]'])).toBe(true);
  });

  it('keeps tabs on the chat list', () => {
    expect(shouldHideTabBar('/', ['(app)', '(tabs)', '(4_chat)', 'index'])).toBe(false);
  });

  it('keeps tabs on a one-segment route outside the chat tab', () => {
    expect(shouldHideTabBar('/abc123', ['(app)', '(tabs)', '(2_agents)', '[id]'])).toBe(false);
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
  it('counts Home, Agents, Chat, and Profile when KiloClaw is hidden', () => {
    expect(visibleTabCount(false)).toBe(4);
  });

  it('adds the KiloClaw tab when visible', () => {
    expect(visibleTabCount(true)).toBe(5);
  });
});

describe('tabBarPosition', () => {
  const withoutKiloClaw = { showKiloClaw: false };
  const withKiloClaw = { showKiloClaw: true };

  it('positions Home at 1 regardless of KiloClaw visibility', () => {
    expect(tabBarPosition('home', withoutKiloClaw)).toBe(1);
    expect(tabBarPosition('home', withKiloClaw)).toBe(1);
  });

  it('returns null for a hidden KiloClaw tab', () => {
    expect(tabBarPosition('kiloclaw', withoutKiloClaw)).toBeNull();
  });

  it('positions KiloClaw at 2 when shown', () => {
    expect(tabBarPosition('kiloclaw', withKiloClaw)).toBe(2);
  });

  it('positions Agents after KiloClaw', () => {
    expect(tabBarPosition('agents', withoutKiloClaw)).toBe(2);
    expect(tabBarPosition('agents', withKiloClaw)).toBe(3);
  });

  it('always positions Chat after Agents', () => {
    expect(tabBarPosition('chat', withoutKiloClaw)).toBe(3);
    expect(tabBarPosition('chat', withKiloClaw)).toBe(4);
  });

  it('positions Profile last regardless of KiloClaw visibility', () => {
    expect(tabBarPosition('profile', withoutKiloClaw)).toBe(4);
    expect(tabBarPosition('profile', withKiloClaw)).toBe(5);
  });
});

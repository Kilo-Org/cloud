import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';

const TAB_BAR_BASE_HEIGHT = 50;
const ANDROID_TAB_BAR_EXTRA_PADDING = 4;
export const TAB_LABEL_WRAP_FONT_SCALE = 1.8;
/**
 * Above this font scale the tab bar drops visible labels and switches to an
 * icon-forward presentation. The label height (which scales with fontScale) is
 * removed from the overlay height calculation, so the bar stays at the base
 * 50pt instead of ballooning. Labels remain available to assistive tech via
 * `tabBarAccessibilityLabel`. Picked above the label-wrap threshold so
 * moderate-to-large text still keeps a visible word label.
 */
export const TAB_ICON_FORWARD_FONT_SCALE = 2;
const TAB_ICON_BASE_SIZE = 22;
const TAB_ICON_MAX_SIZE = 26;

type TabBarPlatform = 'android' | 'ios' | 'macos' | 'windows' | 'web';

export function getTabBarOverlayHeight(
  bottomInset: number,
  platform: TabBarPlatform,
  fontScale = 1
): number {
  const labelLines = fontScale > TAB_LABEL_WRAP_FONT_SCALE ? 2 : 1;
  const tabContentHeight = 34 + 16 * fontScale * labelLines;
  return (
    Math.max(TAB_BAR_BASE_HEIGHT, tabContentHeight) +
    Math.max(bottomInset, 0) +
    (platform === 'android' ? ANDROID_TAB_BAR_EXTRA_PADDING : 0)
  );
}

/**
 * Overlay height for the icon-forward presentation (font scale at or above
 * `TAB_ICON_FORWARD_FONT_SCALE`). The label is hidden so the bar can stay at
 * the base 50pt instead of growing with the (hidden) label height.
 */
export function getTabBarIconForwardHeight(bottomInset: number, platform: TabBarPlatform): number {
  return (
    TAB_BAR_BASE_HEIGHT +
    Math.max(bottomInset, 0) +
    (platform === 'android' ? ANDROID_TAB_BAR_EXTRA_PADDING : 0)
  );
}

/**
 * Bounded icon size for the tab bar. Icons grow gently with the system font
 * scale so they keep visual weight at large text, but are clamped to avoid
 * bloating the bar and pushing the layout out of premium density.
 */
export function getTabBarIconSize(fontScale = 1): number {
  const scaled = Math.round(TAB_ICON_BASE_SIZE * fontScale);
  return Math.min(TAB_ICON_MAX_SIZE, Math.max(TAB_ICON_BASE_SIZE, scaled));
}

/**
 * Effective rendered tab bar height for the current platform/font scale. This
 * is the single source of truth for both the tab bar itself and the content
 * clearance below it: it switches to the compact icon-forward height once labels
 * are hidden, and otherwise uses the label-inclusive overlay height.
 */
export function getEffectiveTabBarHeight({
  bottomInset,
  platform,
  fontScale = 1,
}: {
  bottomInset: number;
  platform: TabBarPlatform;
  fontScale?: number;
}): number {
  return shouldShowTabLabel(fontScale)
    ? getTabBarOverlayHeight(bottomInset, platform, fontScale)
    : getTabBarIconForwardHeight(bottomInset, platform);
}

export function shouldShowTabLabel(fontScale = 1): boolean {
  return fontScale < TAB_ICON_FORWARD_FONT_SCALE;
}

export function shouldHideTabBar(pathname: string): boolean {
  const parts = pathname.split('/').filter(Boolean);
  const isKiloClawInstancePicker = parts[0] === 'chat' && parts.length === 3;
  const isSecurityFindingFilter =
    parts[0] === 'security-agent' && parts.length === 3 && parts[2] === 'filter';
  return isKiloClawInstancePicker || isSecurityFindingFilter;
}

/** One tab bar entry, in render order. */
export type TabBarTab = 'home' | 'kiloclaw' | 'agents' | 'chat' | 'profile';

/** Flag state that changes which tabs render. */
export type TabBarTabFlags = {
  showKiloClaw: boolean;
  showChat: boolean;
};

/**
 * Number of rendered tabs. Base three (Home, Agents, Profile) plus the two
 * flagged tabs when shown.
 */
export function visibleTabCount(showKiloClaw: boolean, showChat: boolean): number {
  return 3 + Number(showKiloClaw) + Number(showChat);
}

/**
 * One-based render position of a tab, or null when the tab is hidden. Home is
 * always 1; KiloClaw sits at 2 when shown; Agents follows KiloClaw; Chat
 * follows Agents when shown; Profile is always last.
 */
export function tabBarPosition(tab: TabBarTab, flags: TabBarTabFlags): number | null {
  switch (tab) {
    case 'home': {
      return 1;
    }
    case 'kiloclaw': {
      return flags.showKiloClaw ? 2 : null;
    }
    case 'agents': {
      return 2 + Number(flags.showKiloClaw);
    }
    case 'chat': {
      return flags.showChat ? 3 + Number(flags.showKiloClaw) : null;
    }
    case 'profile': {
      return visibleTabCount(flags.showKiloClaw, flags.showChat);
    }
    default: {
      // `TabBarTab` is a closed union; this branch is unreachable but keeps
      // `consistent-return` satisfied for an exhaustive switch.
      return null;
    }
  }
}

/**
 * Accessibility label for a tab bar entry. The position and the total must match
 * the rendered tab count, which changes when the KiloClaw tab is hidden.
 */
export function tabAccessibilityLabel(name: string, position: number, total: number): string {
  return i18n.t('tabs.position', {
    name,
    position: formatNumber(position, i18n.language),
    total: formatNumber(total, i18n.language),
  });
}

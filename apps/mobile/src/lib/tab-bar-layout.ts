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

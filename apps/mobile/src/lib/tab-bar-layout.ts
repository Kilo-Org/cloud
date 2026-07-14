const TAB_BAR_BASE_HEIGHT = 50;
const ANDROID_TAB_BAR_EXTRA_PADDING = 4;
export const TAB_LABEL_WRAP_FONT_SCALE = 1.8;

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

export function shouldHideTabBar(pathname: string): boolean {
  const parts = pathname.split('/').filter(Boolean);
  const isKiloClawInstancePicker = parts[0] === 'chat' && parts.length === 3;
  const isSecurityFindingFilter =
    parts[0] === 'security-agent' && parts.length === 3 && parts[2] === 'filter';
  return isKiloClawInstancePicker || isSecurityFindingFilter;
}

export const TAB_BAR_BASE_HEIGHT = 50;
export const ANDROID_TAB_BAR_EXTRA_PADDING = 4;

type TabBarPlatform = 'android' | 'ios' | 'macos' | 'windows' | 'web';

export function getTabBarOverlayHeight(bottomInset: number, platform: TabBarPlatform): number {
  return (
    TAB_BAR_BASE_HEIGHT +
    Math.max(bottomInset, 0) +
    (platform === 'android' ? ANDROID_TAB_BAR_EXTRA_PADDING : 0)
  );
}

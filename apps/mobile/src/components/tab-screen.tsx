import { Platform, ScrollView, type ScrollViewProps, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RefreshProgress } from '@/components/ui/refresh-progress';
import { getEffectiveTabBarHeight } from '@/lib/tab-bar-layout';

const TAB_SCREEN_BOTTOM_GAP = 16;

// FlatList/FlashList screens use this directly for contentContainerStyle.paddingBottom.
export function useTabBarBottomPadding() {
  const { bottom } = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  return (
    getEffectiveTabBarHeight({ bottomInset: bottom, platform: Platform.OS, fontScale }) +
    TAB_SCREEN_BOTTOM_GAP
  );
}

export function TabScreenScrollView({
  children,
  style,
  refreshControl,
  ...props
}: ScrollViewProps) {
  const paddingBottom = useTabBarBottomPadding();
  // Reserve the tab bar's space in the layout: the bar is an absolute blur
  // overlay, and rows parked behind it read as clipped (b911 vr1 spot check,
  // e2-post-revoke-profile.png / e4-profile-again.png — the Profile Sign-out
  // row under the bar). The viewport ends above the bar, so a row is never
  // parked under it. Not contentContainerStyle — setting that style prop
  // makes NativeWind drop the caller's contentContainerClassName (gap/
  // padding), collapsing section spacing.
  return (
    <ScrollView
      {...props}
      refreshControl={refreshControl}
      style={[style, { marginBottom: paddingBottom }]}
    >
      {refreshControl ? <RefreshProgress refreshControl={refreshControl} /> : null}
      {children}
    </ScrollView>
  );
}

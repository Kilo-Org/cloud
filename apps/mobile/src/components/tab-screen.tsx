import { type Ref } from 'react';
import { ScrollView, type ScrollViewProps } from 'react-native';

import { useEffectiveTabBarHeight } from '@/lib/tab-bar-clearance';

const TAB_SCREEN_BOTTOM_GAP = 16;

// FlatList/FlashList screens use this directly for contentContainerStyle.paddingBottom.
export function useTabBarBottomPadding() {
  return useEffectiveTabBarHeight() + TAB_SCREEN_BOTTOM_GAP;
}

export function TabScreenScrollView({
  children,
  style,
  refreshControl,
  ref,
  ...props
}: ScrollViewProps & { ref?: Ref<ScrollView> }) {
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
      ref={ref}
      refreshControl={refreshControl}
      style={[style, { marginBottom: paddingBottom }]}
    >
      {children}
    </ScrollView>
  );
}

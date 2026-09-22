import { type Ref } from 'react';
import {
  Platform,
  ScrollView,
  type ScrollViewProps,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getEffectiveTabBarHeight } from '@/lib/tab-bar-layout';

const TAB_SCREEN_BOTTOM_GAP = 16;

/** The tab bar's rendered height for the current platform, insets and font scale. */
function useTabBarHeight() {
  const { bottom } = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  return getEffectiveTabBarHeight({ bottomInset: bottom, platform: Platform.OS, fontScale });
}

// FlatList/FlashList screens use this directly for contentContainerStyle.paddingBottom.
export function useTabBarBottomPadding() {
  return useTabBarHeight() + TAB_SCREEN_BOTTOM_GAP;
}

export function TabScreenScrollView({
  children,
  style,
  refreshControl,
  ref,
  ...props
}: ScrollViewProps & { ref?: Ref<ScrollView> }) {
  const tabBarHeight = useTabBarHeight();
  // Reserve the tab bar's space in the layout: the bar is an absolute blur
  // overlay, and rows parked behind it read as clipped (b911 vr1 spot check,
  // e2-post-revoke-profile.png / e4-profile-again.png — the Profile Sign-out
  // row under the bar). The viewport ends at the bar's top edge, so a row is
  // never parked under it.
  //
  // The 16pt final gap is breathing room for the last row, so it rides on a
  // trailing spacer inside the scroll content. On the viewport it also clipped
  // content 16pt ABOVE the bar: dark landscape Home showed the EXPLORE section
  // header cut mid-text with an empty band below it, above the bar (home
  // landscape spot defect e1). The spacer keeps the last row clear of the bar
  // when the content is scrolled to the end without stealing a row of the
  // viewport.
  //
  // A trailing spacer, not contentContainerStyle — setting that style prop
  // makes NativeWind drop the caller's contentContainerClassName (gap/
  // padding), collapsing section spacing. The same pattern as
  // DetailScreenScrollView.
  return (
    <ScrollView
      {...props}
      ref={ref}
      refreshControl={refreshControl}
      style={[style, { marginBottom: tabBarHeight }]}
    >
      {children}
      <View style={{ height: TAB_SCREEN_BOTTOM_GAP }} pointerEvents="none" />
    </ScrollView>
  );
}

import { type Ref } from 'react';
import { ScrollView, type ScrollViewProps, View } from 'react-native';

import { useEffectiveTabBarHeight } from '@/lib/tab-bar-clearance';

const TAB_SCREEN_BOTTOM_GAP = 16;

/**
 * The tab bar's rendered height for this screen's clearance:
 * `useEffectiveTabBarHeight` supplies the tabs layout's label decision, the
 * safe-area bottom inset and the platform, so the clearance cannot drift from
 * the rendered bar height. Shared by the scroll viewport and by
 * `useTabBarBottomPadding`.
 */
function useTabBarHeight() {
  return useEffectiveTabBarHeight();
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

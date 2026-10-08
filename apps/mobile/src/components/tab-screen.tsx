import { type Ref, useEffect, useRef } from 'react';
import { Platform, ScrollView, type ScrollViewProps, View } from 'react-native';

import { useKeyboardOcclusion } from '@/components/kilo-chat/app-aware-keyboard-padding';
import { useEffectiveTabBarHeight } from '@/lib/tab-bar-clearance';
import { useScreenInsets } from '@/lib/screen-insets';

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
  keyboardShouldPersistTaps = 'handled',
  onKeyboardOcclusionChange,
  ref,
  ...props
}: ScrollViewProps & {
  ref?: Ref<ScrollView>;
  /**
   * Reports the IME occlusion this scroll view reserves, `0` while the keyboard
   * is down. A caller that must reveal its own pinned bottom action once the
   * occlusion lands reads it from here instead of adding a second keyboard
   * listener. Kept in a ref so an inline callback does not resubscribe the
   * effect on every render.
   */
  onKeyboardOcclusionChange?: (occlusion: number) => void;
}) {
  const tabBarHeight = useTabBarHeight();
  const { left, right } = useScreenInsets();
  const { keyboardOcclusion } = useKeyboardOcclusion();
  const onKeyboardOcclusionChangeRef = useRef(onKeyboardOcclusionChange);
  useEffect(() => {
    onKeyboardOcclusionChangeRef.current = onKeyboardOcclusionChange;
  }, [onKeyboardOcclusionChange]);
  useEffect(() => {
    onKeyboardOcclusionChangeRef.current?.(keyboardOcclusion);
  }, [keyboardOcclusion]);

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
  //
  // While the keyboard is up the tab bar is already hidden
  // (`tabBarHideOnKeyboard`), so the tab-bar band is replaced, not stacked: the
  // viewport ends at the IME's top edge so a form's Submit action can scroll
  // clear of the keyboard and stay tappable (Android's edge-to-edge window does
  // not resize for the IME, so a keyboard-blind frame parked the last row — the
  // Delete-account confirmation submit — behind the keyboard with no way to
  // scroll it clear). `keyboardShouldPersistTaps` defaults to `handled` so that
  // submit button receives the tap while the keyboard is open instead of the
  // first tap only dismissing it.
  //
  // On iOS a caller that opts into `automaticallyAdjustKeyboardInsets` gets the
  // IME reserved by the native content inset, which also reveals the focused
  // field; shrinking the frame by the same occlusion here would book it twice
  // (a keyboard-height band of blank scroll space). Those callers keep the
  // tab-bar clearance with the keyboard down and none with it up. Android has
  // no such prop, so the frame margin is the only reservation there and stays.
  const reservesImeNatively =
    Platform.OS === 'ios' && props.automaticallyAdjustKeyboardInsets === true;
  // With the keyboard down the margin is the tab bar's band. With it up the
  // tab bar hides, so the band is replaced by the IME occlusion everywhere
  // except the iOS native-inset callers above, which reserve none here.
  let frameMargin = tabBarHeight;
  if (keyboardOcclusion > 0) {
    frameMargin = reservesImeNatively ? 0 : keyboardOcclusion;
  }
  return (
    <ScrollView
      {...props}
      ref={ref}
      refreshControl={refreshControl}
      keyboardShouldPersistTaps={keyboardShouldPersistTaps}
      style={[
        style,
        {
          marginBottom: frameMargin,
          ...(left > 0 ? { marginLeft: left } : undefined),
          ...(right > 0 ? { marginRight: right } : undefined),
        },
      ]}
    >
      {children}
      <View style={{ height: TAB_SCREEN_BOTTOM_GAP }} pointerEvents="none" />
    </ScrollView>
  );
}

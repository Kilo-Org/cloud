import { type Ref, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  ScrollView,
  type ScrollViewProps,
  useWindowDimensions,
  View,
} from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';

import { scrollFocusedInputAboveKeyboard } from '@/lib/keyboard-reveal';
import { useEffectiveTabBarHeight } from '@/lib/tab-bar-clearance';
import { useScreenInsets } from '@/lib/screen-insets';

type ScrollEvent = NativeSyntheticEvent<NativeScrollEvent>;

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

/**
 * A route formSheet opened from the Profile tab can extend under the absolute
 * tab bar on Android. Its last controls need a viewport ending at the bar's
 * top edge, with the 16pt trailing spacer providing breathing room without
 * stealing viewport space.
 *
 * On Android the bar hides with the keyboard, so the frame reserves the IME
 * occlusion instead of the bar height. On iOS the native formSheet covers the
 * underlying tab bar; it owns its safe-area and keyboard insets, so no extra
 * frame margin is needed.
 */
export function SheetScrollView({ children, style, ...props }: ScrollViewProps) {
  const tabBarHeight = useTabBarHeight();
  const keyboardOcclusion = useKeyboardState(state => state.height);
  let frameMargin = 0;
  if (Platform.OS === 'android') {
    frameMargin = keyboardOcclusion > 0 ? keyboardOcclusion : tabBarHeight;
  }
  return (
    <ScrollView {...props} style={[style, { marginBottom: frameMargin }]}>
      {children}
      <View style={{ height: TAB_SCREEN_BOTTOM_GAP }} pointerEvents="none" />
    </ScrollView>
  );
}

export function TabScreenScrollView({
  children,
  style,
  refreshControl,
  keyboardShouldPersistTaps = 'handled',
  onKeyboardOcclusionChange,
  // automaticallyAdjustKeyboardInsets is deliberately dropped: the wrapper
  // reserves the IME in the frame instead (see the frameMargin comment).
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
  // The provider's keyboard height reaches the screen bottom on both platforms.
  const keyboardOcclusion = useKeyboardState(state => state.height);
  // The wrapper's own scroll-view ref, so the reveal below can drive the
  // responder even when the caller passes none.
  const internalRef = useRef<ScrollView | null>(null);
  useImperativeHandle<ScrollView | null, ScrollView | null>(ref, () => internalRef.current, []);
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
  // With the keyboard down the margin is the tab bar's band. With it up the
  // tab bar hides, so the band is replaced by the IME occlusion. The IME is
  // always reserved in the frame (never left to the native inset): the native
  // inset does not clamp programmatic scrolls to the keyboard top, leaving
  // focused content under the IME with no scroll range to drag it clear.
  let frameMargin = tabBarHeight;
  if (keyboardOcclusion > 0) {
    frameMargin = keyboardOcclusion;
  }
  // The scroll view's own focused-field reveal runs on focus only. Two
  // re-layouts leave the focused row (and whatever sits under it) parked behind
  // the IME, and content that ends near the field may not leave enough slack to
  // drag it clear by hand. Re-run the reveal once the keyboard transition has
  // landed:
  // - on a frame size change (a rotation while the field stays focused), and
  // - when the IME opens (the keyboard animation re-insets the content but no
  //   layout event fires).
  const lastFrameRef = useRef<{ width: number; height: number } | null>(null);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The scroll offset the scroll view reports through its own onScroll, so the
  // reveal scrolls relative to the current position.
  const offsetRef = useRef(0);
  const occlusionRef = useRef(0);
  occlusionRef.current = keyboardOcclusion;
  const { height: windowHeight } = useWindowDimensions();
  const scheduleReveal = useCallback(() => {
    clearTimeout(revealTimerRef.current);
    revealTimerRef.current = setTimeout(() => {
      revealTimerRef.current = undefined;
      scrollFocusedInputAboveKeyboard({
        current: internalRef.current,
        offsetRef,
        occlusionRef,
        windowHeight,
      });
    }, 400);
  }, [windowHeight]);
  useEffect(() => {
    const active = keyboardOcclusion > 0;
    if (active) {
      scheduleReveal();
    }
    return () => {
      clearTimeout(revealTimerRef.current);
    };
  }, [keyboardOcclusion, scheduleReveal]);
  const handleFrameLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    const last = lastFrameRef.current;
    lastFrameRef.current = { width, height };
    if (keyboardOcclusion > 0 && last != null && (last.width !== width || last.height !== height)) {
      // The layout event fires before the scroll view has re-laid out its
      // content at the new frame, so revealing synchronously scrolls against
      // stale geometry. The reveal timer defers past it.
      scheduleReveal();
    }
    props.onLayout?.(event);
  };
  return (
    <ScrollView
      {...props}
      ref={internalRef}
      onLayout={handleFrameLayout}
      onScroll={(event: ScrollEvent) => {
        offsetRef.current = event.nativeEvent.contentOffset.y;
        props.onScroll?.(event);
      }}
      // The wrapper reserves the IME in the frame itself; the native inset
      // would shrink the visible content a second time.
      automaticallyAdjustKeyboardInsets={false}
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

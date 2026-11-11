import { useCallback, useEffect, useRef } from 'react';
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  ScrollView,
  type ScrollViewInstance,
  type ScrollViewProps,
  useWindowDimensions,
  View,
} from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';

import { RefreshProgress } from '@/components/ui/refresh-progress';
import { scrollFocusedInputAboveKeyboard } from '@/lib/keyboard-reveal';
import { useDetailScreenBottomPadding, useScreenInsets } from '@/lib/screen-insets';

type ScrollEvent = NativeSyntheticEvent<NativeScrollEvent>;

type DetailScreenScrollViewProps = ScrollViewProps & {
  /**
   * Draw the reduced-motion progress band over the content instead of
   * reserving its `h-9` row above it.
   *
   * In flow, the band is the content's first child, so the caller's container
   * gap is added after it and its 31.5 dp reserve pushes the first child down
   * whenever reduced motion is on: a screen whose first block must sit one
   * section gap below its header would show a band three times that gap under
   * reduced motion. Out of flow it takes neither the gap nor the height, and
   * the static spinner — still the only pull feedback under reduced motion —
   * paints over the top of the first child while a refresh is in flight.
   *
   * Opt-in: every other caller keeps the reserved band.
   */
  overlayRefreshProgress?: boolean;
};

// Detail-screen counterpart to TabScreenScrollView. Provides bottom clearance via
// a trailing spacer instead of contentContainerStyle — setting that style prop
// makes NativeWind drop the caller's contentContainerClassName (padding/gap).
export function DetailScreenScrollView({
  children,
  style,
  overlayRefreshProgress = false,
  ...props
}: DetailScreenScrollViewProps) {
  const paddingBottom = useDetailScreenBottomPadding();
  const { left, right } = useScreenInsets();
  // Native-inset callers rely on the scroll view's own focused-field reveal,
  // which runs on focus only. Two re-layouts leave the focused row parked
  // behind the IME: a rotation while the field stays focused, and the IME
  // opening (the keyboard animation re-insets the content but no layout event
  // fires). Re-run the reveal once the transition has landed; see tab-screen.tsx
  // for the full reasoning.
  const reservesImeNatively =
    Platform.OS === 'ios' && props.automaticallyAdjustKeyboardInsets === true;
  const keyboardOcclusion = useKeyboardState(state => state.height);
  const { height: windowHeight } = useWindowDimensions();
  const scrollRef = useRef<ScrollViewInstance | null>(null);
  const lastFrameRef = useRef<{ width: number; height: number } | null>(null);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const offsetRef = useRef(0);
  const occlusionRef = useRef(0);
  occlusionRef.current = keyboardOcclusion;
  const scheduleReveal = useCallback(() => {
    clearTimeout(revealTimerRef.current);
    revealTimerRef.current = setTimeout(() => {
      revealTimerRef.current = undefined;
      scrollFocusedInputAboveKeyboard({
        current: scrollRef.current,
        offsetRef,
        occlusionRef,
        windowHeight,
      });
    }, 400);
  }, [windowHeight]);
  useEffect(() => {
    const active = reservesImeNatively && keyboardOcclusion > 0;
    if (active) {
      scheduleReveal();
    }
    return () => {
      clearTimeout(revealTimerRef.current);
    };
  }, [keyboardOcclusion, reservesImeNatively, scheduleReveal]);
  const handleFrameLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    const last = lastFrameRef.current;
    lastFrameRef.current = { width, height };
    if (
      reservesImeNatively &&
      keyboardOcclusion > 0 &&
      last != null &&
      (last.width !== width || last.height !== height)
    ) {
      // The layout event fires before the scroll view has re-laid out its
      // content at the new frame, so revealing synchronously scrolls against
      // stale geometry. The reveal timer defers past it.
      scheduleReveal();
    }
    props.onLayout?.(event);
  };
  const refreshBand = props.refreshControl ? (
    <RefreshProgress refreshControl={props.refreshControl} />
  ) : null;
  return (
    <ScrollView
      {...props}
      ref={scrollRef}
      onLayout={handleFrameLayout}
      onScroll={(event: ScrollEvent) => {
        offsetRef.current = event.nativeEvent.contentOffset.y;
        props.onScroll?.(event);
      }}
      // The wrapper reserves the IME in the frame itself; the native inset
      // would shrink the visible content a second time.
      automaticallyAdjustKeyboardInsets={false}
      style={[
        style,
        {
          // No tab-bar band here: the trailing spacer carries the bottom
          // padding while the keyboard is down, and the IME occlusion replaces
          // it while the keyboard is up.
          marginBottom: Math.max(keyboardOcclusion, 0),
          ...(left > 0 ? { marginLeft: left } : undefined),
          ...(right > 0 ? { marginRight: right } : undefined),
        },
      ]}
    >
      {refreshBand !== null && overlayRefreshProgress ? (
        <View className="absolute inset-x-0 top-0" pointerEvents="none">
          {refreshBand}
        </View>
      ) : (
        refreshBand
      )}
      {children}
      <View style={{ height: paddingBottom }} pointerEvents="none" />
    </ScrollView>
  );
}

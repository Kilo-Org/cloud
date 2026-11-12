import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  type LayoutChangeEvent,
  PixelRatio,
  ScrollView,
  type ScrollViewInstance,
  type ScrollViewProps,
  useWindowDimensions,
  View,
} from 'react-native';

import { ShortCenteredBandProvider } from '@/components/centered-state-band';
import { useStateSurface } from '@/components/centered-state-surface';
import { RefreshProgress } from '@/components/ui/refresh-progress';
import {
  getCenteredStateLayout,
  getPendingCenteredStateStyle,
  isShortViewport,
  type StateFrame,
} from '@/lib/centered-state-layout';
import { cn } from '@/lib/utils';

type CenteredStateProps = {
  children: ReactNode;
  /** Classes for the scroller itself: background, width. */
  className?: string;
  /**
   * Classes for the content box that holds the caller's children. A horizontal
   * inset belongs here: the scroller's own padding does not narrow the scroll
   * content, so an inset set through `className` leaves the end side flush in a
   * right-to-left layout, and the scroller's content container style already
   * carries the centering layout, so a class applied there is replaced by it.
   */
  contentContainerClassName?: string;
  testID?: string;
  refreshControl?: ScrollViewProps['refreshControl'];
};

type MeasuredViewport = { frame: StateFrame; surface: StateFrame };

/**
 * Centered data state (empty, status, error) inside the band a screen surface
 * reserves.
 *
 * The state paints from its first frame: a hidden data state is a blank body,
 * which reads as a broken screen. That first frame and the measured one use one
 * placement — centered in the band the scroller shows, above the surface's
 * bottom reserve — so a state never moves after it is first painted. The layout
 * engine produces the pending placement from the caller's reserve alone, and
 * `getCenteredStateLayout` produces the same numbers once the surface, the
 * scroller and the content have reported their sizes.
 */
export function CenteredState({
  children,
  className,
  contentContainerClassName,
  testID = 'centered-state',
  refreshControl,
}: CenteredStateProps) {
  const surface = useStateSurface();
  const windowSize = useWindowDimensions();
  const shortBand = isShortViewport(windowSize.width, windowSize.height);
  // The clip the band lives in: the window, in the same window coordinates the
  // scroller reports through `measureInWindow`. Measured bands carry sub-pixel
  // noise — a re-measure of the same layout can report a different fraction of
  // a point — so round it to whole pixels and place every measurement of one
  // layout identically.
  const frame = useMemo(
    () => ({
      top: PixelRatio.roundToNearestPixel(0),
      bottom: PixelRatio.roundToNearestPixel(windowSize.height),
    }),
    [windowSize.height]
  );
  const topInset = surface?.frame ? surface.topInset : 0;
  const bottomInset = surface?.frame ? surface.bottomInset : (surface?.bottomReservation ?? 0);
  const boundsBottom = surface?.frame ? surface.bounds?.bottom : frame.bottom;
  const nativeViewportFillsSurface = surface?.frame ? surface.nativeViewportFillsSurface : false;
  const scrollRef = useRef<ScrollViewInstance | null>(null);
  const requestRef = useRef(0);
  const [viewport, setViewport] = useState<MeasuredViewport | null>(null);
  const [contentHeight, setContentHeight] = useState<number | null>(null);

  const register = surface?.register;
  useLayoutEffect(() => register?.(), [register]);

  const measure = useCallback(() => {
    requestRef.current += 1;
    const request = requestRef.current;
    const node = scrollRef.current?.getNativeScrollRef();
    if (!node) {
      // The scroller's native node is briefly absent while a screen that owned
      // this surface comes back and re-attaches its host view. The geometry it
      // had is the geometry it still has, so the placement it already carries
      // stays: dropping it here is what made a returning state re-center and
      // then jump back to its measured position. The measurement publishes a
      // fresh object each run, so compare the band, not the identity.
      setViewport(previous =>
        previous !== null &&
        previous.surface.top === frame.top &&
        previous.surface.bottom === frame.bottom
          ? previous
          : null
      );
      return;
    }
    node.measureInWindow((...bounds) => {
      const [, top, , height] = bounds;
      if (request !== requestRef.current) {
        return;
      }
      const measuredTop = PixelRatio.roundToNearestPixel(top);
      const measuredBottom = PixelRatio.roundToNearestPixel(top + height);
      if (
        height <= 0 ||
        !Number.isFinite(measuredTop) ||
        !Number.isFinite(measuredBottom) ||
        measuredBottom <= measuredTop
      ) {
        setViewport(null);
        return;
      }
      setViewport(previous =>
        previous !== null &&
        previous.surface.top === frame.top &&
        previous.surface.bottom === frame.bottom &&
        previous.frame.top === measuredTop &&
        previous.frame.bottom === measuredBottom
          ? previous
          : {
              surface: { top: frame.top, bottom: frame.bottom },
              frame: { top: measuredTop, bottom: measuredBottom },
            }
      );
    });
  }, [frame]);

  const capture = useCallback(
    (node: ScrollViewInstance | null) => {
      scrollRef.current = node;
      measure();
    },
    [measure]
  );

  useLayoutEffect(() => {
    measure();
    return () => {
      requestRef.current += 1;
    };
  }, [measure]);

  const measureContent = useCallback((event: LayoutChangeEvent) => {
    setContentHeight(PixelRatio.roundToNearestPixel(event.nativeEvent.layout.height));
  }, []);
  const layout = useMemo(() => {
    // The stored viewport carries the band it was measured against, and the
    // surface publishes a fresh frame object on every measurement, so compare
    // the band itself: a state whose surface has not moved keeps its placement
    // instead of dropping back to the pending one and jumping when it returns.
    const measured = viewport;
    if (
      !measured ||
      measured.surface.top !== frame.top ||
      measured.surface.bottom !== frame.bottom ||
      contentHeight === null
    ) {
      return undefined;
    }
    const measuredFrame = measured.frame;
    return getCenteredStateLayout({
      window: frame,
      viewport: measuredFrame,
      contentHeight,
      topInset,
      bottomInset,
      nativeViewportFillsSurface,
      nativeViewportBottom: boundsBottom,
      roundToPixel: value => PixelRatio.roundToNearestPixel(value),
    });
  }, [
    boundsBottom,
    bottomInset,
    contentHeight,
    frame,
    nativeViewportFillsSurface,
    topInset,
    viewport,
  ]);
  // While the measured layout is pending, the state paints with the layout
  // engine's own centering and the same bottom reserve the measured layout
  // applies, so the band the surface reserved (the fixed tab bar) stays free
  // and the position it paints is the position the measurement confirms. This
  // padding is the only reservation — a caller that also shrinks the scroller
  // frame by the same band clears it twice and pushes the body above the centre
  // of the visible area.
  const contentStyle = useMemo(
    () => ({ flexGrow: 1, ...(layout ?? getPendingCenteredStateStyle(bottomInset)) }),
    [bottomInset, layout]
  );

  if (!surface) {
    throw new Error('CenteredState requires a StateSurface');
  }

  return (
    <ShortCenteredBandProvider value={shortBand}>
      <ScrollView
        ref={capture}
        className={cn('flex-1', className)}
        testID={testID}
        onLayout={measure}
        contentContainerStyle={contentStyle}
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustKeyboardInsets={false}
        refreshControl={refreshControl}
        keyboardShouldPersistTaps="handled"
      >
        <View
          className={cn('w-full', contentContainerClassName)}
          testID={testID ? `${testID}-content` : undefined}
          onLayout={measureContent}
        >
          {refreshControl ? <RefreshProgress refreshControl={refreshControl} /> : null}
          {children}
        </View>
      </ScrollView>
    </ShortCenteredBandProvider>
  );
}

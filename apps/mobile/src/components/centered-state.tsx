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
  getCenteredStateBandStyle,
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
 *
 * The pending placement is the band placement for a band that starts at the
 * scroller's top and ends at the scroller's bottom, which is every band a screen
 * paints. A reserved top inset moves the band's top below the scroller's top and
 * a native-filled viewport moves its bottom below the scroller's bottom; the
 * estimate has no scroller frame to follow either of them, so those bands keep
 * the content back until the scroller reports its own frame. The measurement
 * answers inside the commit that mounts the scroller, so the state paints placed
 * rather than at a position the measurement then corrects. It also paints at the
 * estimate whenever a measurement cannot place it at all, because a state that
 * never appears is worse than one placed by the estimate.
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
  // Whether the last measurement could place the state at all: no scroller node
  // yet, or bounds that name no area. A band that cannot be estimated needs this
  // to tell a measurement in flight from one that will never arrive.
  const [unplaceable, setUnplaceable] = useState(false);

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
      setUnplaceable(true);
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
        setUnplaceable(true);
        setViewport(null);
        return;
      }
      setUnplaceable(false);
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

  const measureContent = useCallback((event: LayoutChangeEvent) => {
    setContentHeight(PixelRatio.roundToNearestPixel(event.nativeEvent.layout.height));
  }, []);

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

  // The stored viewport carries the band it was measured against, and the window
  // frame is a fresh object on every dimension change, so compare the band
  // itself: a state whose window has not moved keeps its placement instead of
  // dropping back to the pending one and jumping when it returns.
  const measuredViewport = useMemo(() => {
    if (
      !viewport ||
      viewport.surface.top !== frame.top ||
      viewport.surface.bottom !== frame.bottom
    ) {
      return null;
    }
    return viewport.frame;
  }, [frame, viewport]);

  // The placement: centered in the band the scroller shows. Until the content
  // reports its height the band style places it by centering alone, which is the
  // same position, so the first frame and every later frame agree.
  const layout = useMemo(() => {
    if (!measuredViewport) {
      return undefined;
    }
    const band = {
      window: frame,
      viewport: measuredViewport,
      topInset,
      bottomInset,
      nativeViewportFillsSurface,
      nativeViewportBottom: boundsBottom,
    };
    if (contentHeight === null) {
      return getCenteredStateBandStyle(band);
    }
    return getCenteredStateLayout({
      ...band,
      contentHeight,
      roundToPixel: value => PixelRatio.roundToNearestPixel(value),
    });
  }, [
    boundsBottom,
    bottomInset,
    contentHeight,
    frame,
    measuredViewport,
    nativeViewportFillsSurface,
    topInset,
  ]);
  // The pending placement centers in the scroller and carries the caller's
  // bottom reserve, so the band the surface reserved (the fixed tab bar) stays
  // free and the position it paints is the position the measurement confirms.
  // This padding is the only reservation — a caller that also shrinks the
  // scroller frame by the same band clears it twice and pushes the body above
  // the centre of the visible area. It is the band placement for a band that
  // starts at the scroller's top; a reserved top inset and a native-filled
  // viewport move that band off the scroller's own edges, so those bands wait
  // for the scroller's frame instead of painting a position the measurement
  // would correct. The estimate still lands whenever a measurement cannot place
  // the state, so a state never stays hidden.
  const estimateFits = topInset === 0 && !nativeViewportFillsSurface;
  const placement = useMemo(() => {
    if (layout) {
      return layout;
    }
    return estimateFits || unplaceable ? getPendingCenteredStateStyle(bottomInset) : null;
  }, [bottomInset, estimateFits, layout, unplaceable]);
  const contentStyle = useMemo(
    () => (placement ? { flexGrow: 1, ...placement } : undefined),
    [placement]
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
        {contentStyle === undefined ? null : (
          <View
            className={cn('w-full', contentContainerClassName)}
            testID={testID ? `${testID}-content` : undefined}
            onLayout={measureContent}
          >
            {refreshControl ? <RefreshProgress refreshControl={refreshControl} /> : null}
            {children}
          </View>
        )}
      </ScrollView>
    </ShortCenteredBandProvider>
  );
}

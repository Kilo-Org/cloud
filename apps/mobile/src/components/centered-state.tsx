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
  /**
   * The frame the state centers in. `surface` (the default) centers on the
   * surface's own frame, which keeps a state steady when the scroller around it
   * grows or shrinks. `viewport` centers in the band this scroller fills — for a
   * state whose scroller sits between chrome the surface does not describe (a
   * chat body between a header and a composer), where centering on the surface
   * moves the state whenever the surface's own measurement arrives.
   */
  band?: 'surface' | 'viewport';
};

type MeasuredViewport = { frame: StateFrame; surface: StateFrame };

/**
 * Centered data state (empty, status, error) inside the band a screen surface
 * reserves.
 *
 * The state paints from its first frame: a hidden data state is a blank body,
 * which reads as a broken screen. The first frame sits at the pending placement
 * — centered in the band the surface reports, or in the window minus the
 * reservation the caller already knows — and the measured placement replaces it
 * once the surface and the content have reported their sizes.
 */
export function CenteredState({
  children,
  className,
  contentContainerClassName,
  testID = 'centered-state',
  refreshControl,
  band = 'surface',
}: CenteredStateProps) {
  const surface = useStateSurface();
  const windowSize = useWindowDimensions();
  const shortBand = isShortViewport(windowSize.width, windowSize.height);
  // A screen whose surface is not published yet still covers the window it
  // fills: its band is the window minus the reservation the caller already
  // knows. Placing against that band is exact for a full-screen state, so a
  // first mount paints where it will be measured instead of at the pending
  // centering and then lifting when the surface arrives.
  const liveFrame = surface?.frame ?? null;
  // Measured bands carry sub-pixel noise: a re-measure of the same layout can
  // report a different fraction of a point, and a placement derived from it
  // moves the state by a pixel for no visual reason. Round the band to whole
  // pixels so repeated measurements of one layout place the state identically.
  const frame = useMemo(() => {
    const live = liveFrame ?? { top: 0, bottom: windowSize.height };
    return {
      top: PixelRatio.roundToNearestPixel(live.top),
      bottom: PixelRatio.roundToNearestPixel(live.bottom),
    };
  }, [liveFrame, windowSize.height]);
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
      surface: frame,
      viewport: measuredFrame,
      contentHeight,
      topInset,
      bottomInset,
      nativeViewportFillsSurface,
      nativeViewportBottom: boundsBottom,
      band,
      roundToPixel: value => PixelRatio.roundToNearestPixel(value),
    });
  }, [
    band,
    boundsBottom,
    bottomInset,
    contentHeight,
    frame,
    nativeViewportFillsSurface,
    topInset,
    viewport,
  ]);
  // While the measured layout is pending, the fallback must still keep the band
  // the surface reserved (the fixed tab bar) free: without it the body centers
  // in the full viewport, which runs under the bar, and the bar clips the
  // body's lower lines and its action. This padding is the only reservation —
  // a caller that also shrinks the scroller frame by the same band clears it
  // twice and pushes the body above the centre of the visible area.
  const bottomReservation = surface?.bottomReservation ?? 0;
  const contentStyle = useMemo(() => {
    const style = layout ?? {
      justifyContent: 'center' as const,
      paddingTop: 16,
      paddingBottom: 16 + bottomReservation,
    };
    return { flexGrow: 1, ...style };
  }, [bottomReservation, layout]);

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

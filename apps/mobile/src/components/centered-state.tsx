import {
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
  /**
   * Identity of this state for placement memory. Two states can share one
   * surface and the default testID — a tab's empty body and a pushed screen's —
   * and each must remember its own placement, not the other's.
   */
  stateKey?: string;
  refreshControl?: ScrollViewProps['refreshControl'];
};

type MeasuredViewport = { frame: StateFrame; surface: StateFrame };

/**
 * The placement a state last painted at. Keyed by route and state, because one
 * surface carries several states — a tab's empty body and a pushed screen's —
 * and a returning screen must not inherit the other one's size.
 */
type RememberedPlacement = {
  windowWidth: number;
  windowHeight: number;
  /** The surface the band belongs to; a sheet's band is not the screen's. */
  register: (() => () => void) | undefined;
  style: { minHeight: number; paddingTop: number; paddingBottom: number };
};

const REMEMBERED_PLACEMENT_LIMIT = 64;
const rememberedPlacements = new Map<string, RememberedPlacement>();

/** Test-only: drop the remembered placements so a suite starts from a cold mount. */
export function _resetRememberedSurfaceForTests(): void {
  rememberedPlacements.clear();
}

/**
 * Centered data state (empty, status, error) inside the band a screen surface
 * reserves.
 *
 * The state paints on its first frame, and that placement is final: a surface
 * that has not measured yet — a screen coming back from a pushed route, the tab
 * bar's own layout pass — carries the remembered placement of the same state on
 * the same route, so the first frame is already the measured one. A hidden data
 * state is a blank body, which reads as a broken screen and outlasts the
 * measurement on a slow device; a first frame at the pending centering lifts
 * about 39 dp when the measurement lands, which is a layout shift.
 */
export function CenteredState({
  children,
  className,
  contentContainerClassName,
  testID = 'centered-state',
  stateKey,
  refreshControl,
}: CenteredStateProps) {
  const surface = useStateSurface();
  const frame = surface?.frame;
  const windowSize = useWindowDimensions();
  const shortBand = isShortViewport(windowSize.width, windowSize.height);
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
    if (!frame) {
      setViewport(null);
      return;
    }
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
      const bottom = top + height;
      if (height <= 0 || !Number.isFinite(top) || !Number.isFinite(bottom)) {
        setViewport(null);
        return;
      }
      setViewport(previous =>
        previous !== null &&
        previous.surface.top === frame.top &&
        previous.surface.bottom === frame.bottom &&
        previous.frame.top === top &&
        previous.frame.bottom === bottom
          ? previous
          : { surface: { top: frame.top, bottom: frame.bottom }, frame: { top, bottom } }
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
      !frame ||
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
      topInset: surface.topInset,
      bottomInset: surface.bottomInset,
      nativeViewportFillsSurface: surface.nativeViewportFillsSurface,
      nativeViewportBottom: surface.bounds?.bottom,
      roundToPixel: value => PixelRatio.roundToNearestPixel(value),
    });
  }, [surface, frame, viewport, contentHeight]);
  const placementKey = stateKey ?? testID;
  const remembered = rememberedPlacements.get(placementKey);
  const rememberedStyle =
    remembered !== undefined &&
    remembered.windowWidth === windowSize.width &&
    remembered.windowHeight === windowSize.height &&
    remembered.register === surface?.register
      ? remembered.style
      : null;
  // Remember the placement this state painted at, so its next mount paints
  // there directly. A route change or a window change makes it stale, and the
  // entries are capped so a session cannot grow the map without bound.
  useLayoutEffect(() => {
    if (layout === undefined) {
      return;
    }
    rememberedPlacements.delete(placementKey);
    rememberedPlacements.set(placementKey, {
      windowWidth: windowSize.width,
      windowHeight: windowSize.height,
      register: surface?.register,
      style: {
        minHeight: layout.minHeight,
        paddingTop: layout.paddingTop,
        paddingBottom: layout.paddingBottom,
      },
    });
    if (rememberedPlacements.size > REMEMBERED_PLACEMENT_LIMIT) {
      const oldest = rememberedPlacements.keys().next().value;
      if (oldest !== undefined) {
        rememberedPlacements.delete(oldest);
      }
    }
  }, [layout, placementKey, surface?.register, windowSize.width, windowSize.height]);
  // While the measured layout is pending, the fallback must still keep the band
  // the surface reserved (the fixed tab bar) free: without it the body centers
  // in the full viewport, which runs under the bar, and the bar clips the
  // body's lower lines and its action. This padding is the only reservation —
  // a caller that also shrinks the scroller frame by the same band clears it
  // twice and pushes the body above the centre of the visible area.
  const bottomReservation = surface?.bottomReservation ?? 0;
  const contentStyle = useMemo(() => {
    const style =
      layout ?? rememberedStyle ?? {
        justifyContent: 'center' as const,
        paddingTop: 16,
        paddingBottom: 16 + bottomReservation,
      };
    return { flexGrow: 1, ...style };
  }, [bottomReservation, layout, rememberedStyle]);

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

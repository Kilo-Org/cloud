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
  refreshControl?: ScrollViewProps['refreshControl'];
};

type MeasuredViewport = { frame: StateFrame; surface: StateFrame };

/** What a state last painted against, so a returning screen can reuse it. */
type RememberedSurface = {
  windowWidth: number;
  windowHeight: number;
  /** The surface the band belongs to; a sheet's band is not the screen's. */
  register: (() => () => void) | undefined;
  frame: StateFrame;
  topInset: number;
  bottomInset: number;
  boundsBottom: number | undefined;
  nativeViewportFillsSurface: boolean;
};

/**
 * The last surface geometry a state placed against. A screen coming back from a
 * pushed route unpublishes its surface for the length of the transition: the
 * frame is momentarily absent while the host view re-attaches, and a state that
 * waited for it painted at the scroller-relative pending placement and then
 * lifted about 39 dp to its measured one. The window's band is the band it
 * already was, so the next mount paints against the remembered geometry and
 * never moves; a different window (rotation, a resized split) never matches and
 * measures for itself.
 */
let rememberedSurface: RememberedSurface | null = null;

/** Test-only: drop the remembered band so a suite starts from a cold mount. */
export function _resetRememberedSurfaceForTests(): void {
  rememberedSurface = null;
}

/**
 * Centered data state (empty, status, error) inside the band a screen surface
 * reserves.
 *
 * The state paints on its first frame, and that placement is final for the
 * mount: a surface that has not measured yet — a screen coming back from a
 * pushed route, the tab bar's own layout pass, a rotation — carries the
 * remembered geometry it last painted against, so the first frame is already
 * the measured placement. A hidden data state is a blank body, which reads as a
 * broken screen and outlasts the measurement on a slow device.
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
  const scrollRef = useRef<ScrollViewInstance | null>(null);
  const requestRef = useRef(0);
  const [viewport, setViewport] = useState<MeasuredViewport | null>(null);
  const [contentHeight, setContentHeight] = useState<number | null>(null);

  // The geometry this state paints against: the live surface while it is
  // published, and otherwise the band this window had last time. A returning
  // screen unpublishes the surface for the length of its transition, and the
  // band does not move in that gap.
  const remembered =
    rememberedSurface !== null &&
    rememberedSurface.windowWidth === windowSize.width &&
    rememberedSurface.windowHeight === windowSize.height &&
    rememberedSurface.register === surface?.register
      ? rememberedSurface
      : null;
  const frame = surface?.frame ?? remembered?.frame ?? null;
  const topInset = surface?.frame ? surface.topInset : (remembered?.topInset ?? 0);
  const bottomInset = surface?.frame ? surface.bottomInset : (remembered?.bottomInset ?? 0);
  const boundsBottom = surface?.frame ? surface.bounds?.bottom : remembered?.boundsBottom;
  const nativeViewportFillsSurface = surface?.frame
    ? surface.nativeViewportFillsSurface
    : (remembered?.nativeViewportFillsSurface ?? false);

  // Remember what this state painted against, before the frame is painted, so
  // the next mount of a returning screen places itself exactly here.
  useLayoutEffect(() => {
    if (!surface?.frame) {
      return;
    }
    rememberedSurface = {
      windowWidth: windowSize.width,
      windowHeight: windowSize.height,
      register: surface.register,
      frame: surface.frame,
      topInset: surface.topInset,
      bottomInset: surface.bottomInset,
      boundsBottom: surface.bounds?.bottom,
      nativeViewportFillsSurface: surface.nativeViewportFillsSurface,
    };
  }, [surface, windowSize.width, windowSize.height]);

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
      topInset,
      bottomInset,
      nativeViewportFillsSurface,
      nativeViewportBottom: boundsBottom ?? frame.bottom,
      roundToPixel: value => PixelRatio.roundToNearestPixel(value),
    });
  }, [boundsBottom, bottomInset, contentHeight, frame, nativeViewportFillsSurface, topInset, viewport]);
  const ready = layout !== undefined;
  // While the measured layout is pending, the fallback must still keep the band
  // the surface reserved (the fixed tab bar) free: without it the body centers
  // in the full viewport, which runs under the bar, and the bar clips the
  // body's lower lines and its action. This padding is the only reservation —
  // a caller that also shrinks the scroller frame by the same band clears it
  // twice and pushes the body above the centre of the visible area.
  const bottomReservation = surface?.bottomReservation ?? 0;
  const contentStyle = useMemo(
    () =>
      ready
        ? { flexGrow: 1, ...layout }
        : {
            flexGrow: 1,
            justifyContent: 'center' as const,
            paddingTop: 16,
            paddingBottom: 16 + bottomReservation,
          },
    [bottomReservation, layout, ready]
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

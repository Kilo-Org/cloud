import {
  type ReactNode,
  useCallback,
  useEffect,
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

/**
 * Upper bound on how long the content stays hidden waiting for a surface
 * measurement. A missing or empty native reading must not leave a data state
 * (empty, status, error) invisible forever.
 */
export const STATE_SURFACE_FALLBACK_MS = 400;

export function CenteredState({
  children,
  className,
  contentContainerClassName,
  testID = 'centered-state',
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
  const [fallbackElapsed, setFallbackElapsed] = useState(false);
  // The hidden-until-measured gate keeps a data state from flashing at the wrong
  // spot on its first frame. It must only ever gate that first frame: once the
  // state has been painted, a measurement that lands, detaches and lands again
  // — a restored route, the tab bar's own layout pass, a rotation — must not
  // hide it again. Re-arming this window on every `ready` transition did
  // exactly that, and a run of them kept an empty history body invisible for
  // seconds after a relaunch. The timer starts once at mount, and the reveal is
  // latched for the life of the mount.
  useEffect(() => {
    const timer = setTimeout(() => {
      setFallbackElapsed(true);
    }, STATE_SURFACE_FALLBACK_MS);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  // The latch is a layout effect, and it is declared after the measuring layout
  // effect above: layout effects flush before the frame is painted, so the
  // reveal lands in the same commit that placed the state, and a later detach —
  // which clears the placement in that earlier layout effect — already reads the
  // latch. An ordinary effect would run after paint and let one hidden frame
  // through, which is the blank body a returning screen showed; a render-phase
  // update is not an option either, because it updates a component React has
  // not mounted yet and surfaces as a development-time state-update warning.
  const [revealed, setRevealed] = useState(false);
  const visible = ready || fallbackElapsed || revealed;
  useLayoutEffect(() => {
    if (visible && !revealed) {
      setRevealed(true);
    }
  }, [revealed, visible]);

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
          className={cn('w-full', contentContainerClassName, !visible && 'opacity-0')}
          testID={testID ? `${testID}-content` : undefined}
          onLayout={measureContent}
          accessibilityElementsHidden={!visible}
          importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
        >
          {refreshControl ? <RefreshProgress refreshControl={refreshControl} /> : null}
          {children}
        </View>
      </ScrollView>
    </ShortCenteredBandProvider>
  );
}

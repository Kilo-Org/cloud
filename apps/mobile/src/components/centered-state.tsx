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
  className?: string;
  testID?: string;
  refreshControl?: ScrollViewProps['refreshControl'];
  /**
   * The surface reserves a status band that draws the pull's progress itself
   * (the Agents no-match state's reserved line). A short band cannot hold both
   * the body and the in-body progress strip, so the strip yields to that band.
   * Every other centered refreshable surface has no band to fall back on: the
   * strip is the pull's only reduced-motion indicator there and stays.
   */
  progressInBand?: boolean;
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
  testID = 'centered-state',
  refreshControl,
  progressInBand = false,
}: CenteredStateProps) {
  const surface = useStateSurface();
  const frame = surface?.frame;
  const windowSize = useWindowDimensions();
  const shortBand = isShortViewport(windowSize.width, windowSize.height);
  const scrollRef = useRef<ScrollView | null>(null);
  const requestRef = useRef(0);
  const [viewport, setViewport] = useState<MeasuredViewport | null>(null);
  const [contentHeight, setContentHeight] = useState<number | null>(null);

  const register = surface?.register;
  useLayoutEffect(() => register?.(), [register]);

  const measure = useCallback(() => {
    requestRef.current += 1;
    const request = requestRef.current;
    const node = scrollRef.current?.getNativeScrollRef();
    if (!frame || !node) {
      setViewport(null);
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
        previous?.surface === frame &&
        previous.frame.top === top &&
        previous.frame.bottom === bottom
          ? previous
          : { surface: frame, frame: { top, bottom } }
      );
    });
  }, [frame]);

  const capture = useCallback(
    (node: ScrollView | null) => {
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
  const layout = useMemo(
    () =>
      surface?.frame && viewport?.surface === surface.frame && contentHeight !== null
        ? getCenteredStateLayout({
            surface: surface.frame,
            viewport: viewport.frame,
            contentHeight,
            topInset: surface.topInset,
            bottomInset: surface.bottomInset,
            nativeViewportFillsSurface: surface.nativeViewportFillsSurface,
            nativeViewportBottom: surface.bounds?.bottom,
            roundToPixel: value => PixelRatio.roundToNearestPixel(value),
          })
        : undefined,
    [surface, viewport, contentHeight]
  );
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
  useEffect(() => {
    if (ready) {
      setFallbackElapsed(false);
      return undefined;
    }
    const timer = setTimeout(() => {
      setFallbackElapsed(true);
    }, STATE_SURFACE_FALLBACK_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [ready]);
  const visible = ready || fallbackElapsed;

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
          className={cn('w-full', !visible && 'opacity-0')}
          testID={testID ? `${testID}-content` : undefined}
          onLayout={measureContent}
          accessibilityElementsHidden={!visible}
          importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
        >
          {/*
            The in-body strip reserves the pull's static spinner, which the app
            draws itself while reduced motion has parked the platform control.
            It is measured as part of the body, so a short band — a phone held
            sideways — cannot hold it and the state's copy and its action: on
            the Agents no-match state that reservation is exactly what pushed
            the second line and the Clear-search action under the fixed tab bar
            (landscape UX defect, e1). That surface's own reserved band carries
            the pull (`progressInBand`), so a short band drops the reservation
            there; a centered refreshable surface with no such band keeps the
            strip, which is the pull's only reduced-motion indicator.
          */}
          {refreshControl && !(shortBand && progressInBand) ? (
            <RefreshProgress refreshControl={refreshControl} />
          ) : null}
          {children}
        </View>
      </ScrollView>
    </ShortCenteredBandProvider>
  );
}

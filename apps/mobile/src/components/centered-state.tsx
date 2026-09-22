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
  View,
} from 'react-native';

import { useStateSurface } from '@/components/centered-state-surface';
import { RefreshProgress } from '@/components/ui/refresh-progress';
import { getCenteredStateLayout, type StateFrame } from '@/lib/centered-state-layout';
import { cn } from '@/lib/utils';

type CenteredStateProps = {
  children: ReactNode;
  className?: string;
  testID?: string;
  refreshControl?: ScrollViewProps['refreshControl'];
  /** Frame clearance the caller owns (e.g. the fixed tab-bar band). It shrinks
   *  the measured viewport, so the centered body clears the overlay before any
   *  surface geometry lands; a ready layout can only tighten the same value. */
  frameStyle?: ScrollViewProps['style'];
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
  frameStyle,
}: CenteredStateProps) {
  const surface = useStateSurface();
  const frame = surface?.frame;
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
  // body's lower lines and its action.
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
    <ScrollView
      ref={capture}
      className={cn('flex-1', className)}
      style={frameStyle}
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
        {refreshControl ? <RefreshProgress refreshControl={refreshControl} /> : null}
        {children}
      </View>
    </ScrollView>
  );
}

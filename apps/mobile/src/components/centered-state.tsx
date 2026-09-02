import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type LayoutChangeEvent, ScrollView, type ScrollViewProps, View } from 'react-native';

import { useStateSurface } from '@/components/centered-state-surface';
import { getCenteredStateLayout, type StateFrame } from '@/lib/centered-state-layout';
import { cn } from '@/lib/utils';

type CenteredStateProps = {
  children: ReactNode;
  className?: string;
  testID?: string;
  refreshControl?: ScrollViewProps['refreshControl'];
};

type MeasuredViewport = { frame: StateFrame; surface: StateFrame };

export function CenteredState({
  children,
  className,
  testID = 'centered-state',
  refreshControl,
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
    setContentHeight(event.nativeEvent.layout.height);
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
          })
        : undefined,
    [surface, viewport, contentHeight]
  );
  const contentStyle = useMemo(() => ({ flexGrow: 1, ...layout }), [layout]);
  const ready = layout !== undefined;

  if (!surface) {
    throw new Error('CenteredState requires a StateSurface');
  }

  return (
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
        className={cn('w-full', !ready && 'opacity-0')}
        testID={testID ? `${testID}-content` : undefined}
        onLayout={measureContent}
        accessibilityElementsHidden={!ready}
        importantForAccessibility={ready ? 'auto' : 'no-hide-descendants'}
      >
        {children}
      </View>
    </ScrollView>
  );
}

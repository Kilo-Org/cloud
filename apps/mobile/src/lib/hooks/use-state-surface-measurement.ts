import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useWindowDimensions, type View } from 'react-native';

import { intersectStateFrames, type StateFrame } from '@/lib/centered-state-layout';
import { useNativeStateGeometry } from '@/lib/hooks/use-native-state-geometry';

export type SurfaceMeasurement = {
  frame: StateFrame | null;
  bounds: StateFrame | null;
  safeAreaTop: number;
  safeAreaBottom: number;
  source: 'native' | 'layout' | 'pending';
};

export function useStateSurfaceMeasurement(androidSheet: boolean, nativeActive = true) {
  const nodeRef = useRef<View | null>(null);
  const [nativeNode, setNode] = useState<View | null>(null);
  const native = useNativeStateGeometry(nativeActive ? nativeNode : null);
  const [frame, setFrame] = useState<StateFrame | null>(null);
  const { width, height } = useWindowDimensions();
  const requestRef = useRef(0);
  const mountedRef = useRef(true);

  const measure = useCallback(() => {
    const node = nodeRef.current;
    requestRef.current += 1;
    const request = requestRef.current;
    if (!node) {
      setFrame(null);
      return;
    }
    node.measureInWindow((...bounds) => {
      const [, y, , measuredHeight] = bounds;
      if (!mountedRef.current || request !== requestRef.current) {
        return;
      }
      const top = y - (androidSheet ? node.scrollTop : 0);
      const bottom = top + measuredHeight;
      if (
        measuredHeight <= 0 ||
        !Number.isFinite(top) ||
        !Number.isFinite(bottom) ||
        bottom <= top
      ) {
        setFrame(null);
        return;
      }
      setFrame(previous =>
        previous?.top === top && previous.bottom === bottom ? previous : { top, bottom }
      );
    });
  }, [androidSheet]);

  const capture = useCallback(
    (node: View | null) => {
      nodeRef.current = node;
      setNode(node);
      measure();
    },
    [measure]
  );

  useLayoutEffect(() => {
    mountedRef.current = true;
    measure();
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, [measure, width, height]);

  const measurement = useMemo<SurfaceMeasurement>(() => {
    if (!frame || native.status === 'pending') {
      return { frame: null, bounds: null, safeAreaTop: 0, safeAreaBottom: 0, source: 'pending' };
    }
    if (native.geometry) {
      const bounds = { top: frame.top, bottom: frame.top + native.geometry.boundsHeight };
      const visible = {
        top: frame.top + native.geometry.visibleTop,
        bottom: frame.top + native.geometry.visibleBottom,
      };
      return {
        frame: visible.bottom > visible.top ? visible : null,
        bounds,
        safeAreaTop: native.geometry.safeAreaTop,
        safeAreaBottom: native.geometry.safeAreaBottom,
        source: 'native',
      };
    }
    const visible = androidSheet ? intersectStateFrames(frame, { top: 0, bottom: height }) : frame;
    return {
      frame: visible.bottom > visible.top ? visible : null,
      bounds: frame,
      safeAreaTop: 0,
      safeAreaBottom: 0,
      source: 'layout',
    };
  }, [frame, native.geometry, native.status, androidSheet, height]);

  return useMemo(
    () => ({ ...measurement, node: nativeNode, capture, measure }),
    [measurement, nativeNode, capture, measure]
  );
}

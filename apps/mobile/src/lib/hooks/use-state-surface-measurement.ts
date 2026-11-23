import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useWindowDimensions, type ViewInstance } from 'react-native';

import { intersectStateFrames, type StateFrame } from '@/lib/centered-state-layout';
import { useNativeStateGeometry } from '@/lib/hooks/use-native-state-geometry';

export type SurfaceMeasurement = {
  frame: StateFrame | null;
  bounds: StateFrame | null;
  safeAreaTop: number;
  safeAreaBottom: number;
  source: 'native' | 'layout' | 'pending';
  failure?: string;
};

export function useStateSurfaceMeasurement(androidSheet: boolean, nativeActive = true) {
  const nodeRef = useRef<ViewInstance | null>(null);
  // One value per attachment, not per node: the navigator detaches and re-hands
  // the same view whenever it re-installs the props a scene layout owns, and
  // that re-attachment owes a fresh window measurement. A node identity in
  // state would collapse the detach and the re-attach into no change. `null`
  // means nothing is attached.
  const [attached, setAttached] = useState<{ node: ViewInstance } | null>(null);
  const nativeNode = attached?.node ?? null;
  const native = useNativeStateGeometry(nativeActive ? nativeNode : null);
  const [frame, setFrame] = useState<StateFrame | null>(null);
  const { width, height } = useWindowDimensions();
  const requestRef = useRef(0);

  const measureNode = useCallback(
    (node: ViewInstance | null) => {
      requestRef.current += 1;
      const request = requestRef.current;
      if (!node) {
        setFrame(null);
        return;
      }
      node.measureInWindow((...bounds) => {
        const [, y, , measuredHeight] = bounds;
        if (request !== requestRef.current) {
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
    },
    [androidSheet]
  );

  // One owner per measurement: the ref callback records the attachment, and the
  // layout effect below spends the native pass on it. A ref callback runs in the
  // commit's mutation phase and the effect right after it, so measuring in both
  // spends two native layout measurements on one attach and the first lands only
  // to be superseded on the next frame. Capture stays free of dependencies, so a
  // sheet toggle cannot re-attach the ref at all.
  const capture = useCallback((node: ViewInstance | null) => {
    nodeRef.current = node;
    setAttached(node ? { node } : null);
  }, []);

  const measure = useCallback(() => {
    measureNode(nodeRef.current);
  }, [measureNode]);

  useLayoutEffect(() => {
    if (attached) {
      measureNode(attached.node);
    } else {
      requestRef.current += 1;
      setFrame(null);
    }
    return () => {
      requestRef.current += 1;
    };
  }, [measureNode, attached, width, height]);

  const failure = native.status === 'failed' ? native.failure : undefined;
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
      failure,
    };
  }, [frame, native.geometry, native.status, androidSheet, height, failure]);

  return useMemo(
    () => ({ ...measurement, node: nativeNode, capture, measure }),
    [measurement, nativeNode, capture, measure]
  );
}

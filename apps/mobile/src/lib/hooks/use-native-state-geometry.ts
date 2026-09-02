import { captureException } from '@sentry/react-native';
import { useEffect, useState } from 'react';
import { findNodeHandle, type View } from 'react-native';

import {
  addSurfaceGeometryListener,
  isNativeSurfaceGeometryAvailable,
  type NativeSurfaceGeometry,
  observeSurface,
  unobserveSurface,
} from '@/lib/native-surface-geometry';

type Observation = {
  node: View | null;
  status: 'pending' | 'ready' | 'failed';
  geometry: NativeSurfaceGeometry | null;
  failure?: string;
};

function sameGeometry(left: NativeSurfaceGeometry | null, right: NativeSurfaceGeometry) {
  return (
    left?.tag === right.tag &&
    left.visibleTop === right.visibleTop &&
    left.visibleBottom === right.visibleBottom &&
    left.boundsHeight === right.boundsHeight &&
    left.safeAreaTop === right.safeAreaTop &&
    left.safeAreaBottom === right.safeAreaBottom
  );
}

export function useNativeStateGeometry(node: View | null) {
  const [observation, setObservation] = useState<Observation>({
    node: null,
    status: 'pending',
    geometry: null,
  });

  useEffect(() => {
    if (!isNativeSurfaceGeometryAvailable || !node) {
      return undefined;
    }
    const tag = findNodeHandle(node);
    if (tag === null) {
      setObservation({
        node,
        status: 'failed',
        geometry: null,
        failure: 'Native view tag unavailable',
      });
      return undefined;
    }
    let active = true;
    let receivedGeometry = false;
    const publish = (geometry: NativeSurfaceGeometry) => {
      if (!active || geometry.tag !== tag) {
        return;
      }
      receivedGeometry = true;
      const valid =
        Number.isFinite(geometry.visibleTop) &&
        Number.isFinite(geometry.visibleBottom) &&
        Number.isFinite(geometry.boundsHeight) &&
        Number.isFinite(geometry.safeAreaTop) &&
        Number.isFinite(geometry.safeAreaBottom) &&
        geometry.visibleBottom >= geometry.visibleTop &&
        geometry.boundsHeight >= 0;
      if (!valid) {
        setObservation({
          node,
          status: 'failed',
          geometry: null,
          failure: 'Invalid native surface geometry',
        });
        return;
      }
      setObservation(previous =>
        previous.node === node && sameGeometry(previous.geometry, geometry)
          ? previous
          : { node, status: 'ready', geometry }
      );
    };
    setObservation({ node, status: 'pending', geometry: null });
    const listener = addSurfaceGeometryListener(publish);
    const start = async () => {
      try {
        const geometry = await observeSurface(tag);
        if (!receivedGeometry) {
          publish(geometry);
        }
      } catch (error) {
        if (active) {
          setObservation({
            node,
            status: 'failed',
            geometry: null,
            failure: error instanceof Error ? error.message : 'Native observation failed',
          });
        }
      }
    };
    const stop = async () => {
      try {
        await unobserveSurface(tag);
      } catch (error) {
        captureException(error, {
          tags: { 'error.subsystem': 'surface_geometry', 'error.operation': 'unobserve' },
        });
      }
    };
    const startFrame = requestAnimationFrame(() => {
      if (active) {
        void start();
      }
    });
    return () => {
      active = false;
      cancelAnimationFrame(startFrame);
      listener?.remove();
      void stop();
    };
  }, [node]);

  if (!isNativeSurfaceGeometryAvailable) {
    return { status: 'unavailable' as const, geometry: null };
  }
  if (observation.node !== node) {
    return { status: 'pending' as const, geometry: null };
  }
  return observation;
}

import { useNavigationContainerRef, useSegments } from 'expo-router';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { captureScreen, isPostHogReady, subscribeToPostHogReady } from '@/lib/analytics/posthog';
import {
  decideScreenTracking,
  SCREEN_TRACKING_SETTLE_DEBOUNCE_MS,
  type ScreenTrackingCapture,
} from '@/lib/hooks/screen-tracking-decision';
import { allowsOptional, currentGeneration } from '@/lib/telemetry/controller';

// The telemetry controller exposes no subscription, so the generation counter
// is polled while mounted.
export const SCREEN_TRACKING_GENERATION_POLL_MS = 500;

/**
 * Captures a PostHog `$screen` event for the settled visible leaf route: the
 * navigation state is not stale, the segments stayed unchanged for
 * `SCREEN_TRACKING_SETTLE_DEBOUNCE_MS`, and `bootstrapSettled` (the layout's
 * consent-settled boolean) is true. Screen names keep their bracket
 * placeholders (e.g. `chat/[sandbox-id]`), so no dynamic values leave the
 * device. Dev builds log `[screen-tracking] <name>` for bot E2E.
 */
export function useScreenTracking(bootstrapSettled: boolean): void {
  const segments = useSegments();
  const analyticsReady = useSyncExternalStore(subscribeToPostHogReady, isPostHogReady);
  const lastCapturedRef = useRef<ScreenTrackingCapture | null>(null);

  // Every segment change invalidates the previous settled marker and starts a
  // fresh window, so a revisited leaf also waits out its own quiet period.
  const segmentsKey = segments.join('/');
  const [settledSegmentsKey, setSettledSegmentsKey] = useState<string | null>(null);
  useEffect(() => {
    setSettledSegmentsKey(null);
    const timer = setTimeout(() => {
      setSettledSegmentsKey(segmentsKey);
    }, SCREEN_TRACKING_SETTLE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [segmentsKey]);

  // `useRootNavigationState` is a static snapshot, so a stale-to-false
  // transition would never re-evaluate. Subscribe to the container's `state`
  // events instead. The cast widens the runtime state shape.
  const navigationRef = useNavigationContainerRef();
  const [navState, setNavState] = useState<{ stale?: boolean } | undefined>(
    () => navigationRef.current?.getRootState() as { stale?: boolean } | undefined
  );
  useEffect(() => {
    const update = () => {
      setNavState(navigationRef.current?.getRootState() as { stale?: boolean } | undefined);
    };
    update();
    return navigationRef.addListener('state', update);
  }, [navigationRef]);

  const settled = settledSegmentsKey === segmentsKey && navState?.stale === false;

  // Re-evaluate on account generation changes. The telemetry controller
  // exposes no subscription, so poll its generation counter while mounted.
  const [generationTick, setGenerationTick] = useState(0);
  useEffect(() => {
    let lastGeneration = currentGeneration();
    const timer = setInterval(() => {
      const nextGeneration = currentGeneration();
      if (nextGeneration !== lastGeneration) {
        lastGeneration = nextGeneration;
        setGenerationTick(tick => tick + 1);
      }
    }, SCREEN_TRACKING_GENERATION_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  // The analytics module does not export its client generation, so observe it
  // when readiness flips true (`initPostHog` records it just before notifying).
  // `captureScreen` silently drops events from a stale client, so such a
  // capture must not consume the dedupe slot.
  const [postHogClientGeneration, setPostHogClientGeneration] = useState<number | null>(() =>
    isPostHogReady() ? currentGeneration() : null
  );
  useEffect(() => {
    if (isPostHogReady()) {
      setPostHogClientGeneration(currentGeneration());
    }
  }, [analyticsReady]);

  useEffect(() => {
    const generation = currentGeneration();
    const decision = decideScreenTracking({
      segments,
      settled,
      analyticsReady,
      bootstrapSettled,
      accountGeneration: generation,
      captureAccepted: analyticsReady && allowsOptional() && postHogClientGeneration === generation,
      lastCaptured: lastCapturedRef.current,
    });
    if (!decision.capture) {
      return;
    }
    lastCapturedRef.current = { generation, screenName: decision.screenName };
    captureScreen(decision.screenName);
    if (__DEV__) {
      // eslint-disable-next-line no-console -- dev-only E2E assertion hook for screen tracking
      console.log('[screen-tracking]', decision.screenName);
    }
  }, [
    segments,
    settled,
    analyticsReady,
    bootstrapSettled,
    generationTick,
    postHogClientGeneration,
  ]);
}

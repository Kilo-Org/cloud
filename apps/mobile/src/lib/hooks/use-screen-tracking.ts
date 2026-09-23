import { useNavigationContainerRef, useSegments } from 'expo-router';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { captureScreen, isPostHogReady, subscribeToPostHogReady } from '@/lib/analytics/posthog';
import { getAuthenticatedOwner, subscribeAuthenticatedOwner } from '@/lib/context-scope';
import {
  decideScreenTracking,
  SCREEN_TRACKING_SETTLE_DEBOUNCE_MS,
  type ScreenTrackingCapture,
} from '@/lib/hooks/screen-tracking-decision';
import { allowsOptional, currentGeneration } from '@/lib/telemetry/controller';

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
  // events instead, but keep only the derived `stale` boolean: mirroring the
  // whole tree re-rendered the root layout on every navigation event. The ref
  // compares before dispatching, so an event that leaves the flag unchanged
  // never enters React at all. The cast widens the runtime state shape.
  const navigationRef = useNavigationContainerRef();
  const [navStale, setNavStale] = useState<boolean | undefined>(
    () => (navigationRef.current?.getRootState() as { stale?: boolean } | undefined)?.stale
  );
  const lastNavStaleRef = useRef(navStale);
  useEffect(() => {
    const update = () => {
      const next = (navigationRef.current?.getRootState() as { stale?: boolean } | undefined)
        ?.stale;
      if (lastNavStaleRef.current === next) {
        return;
      }
      lastNavStaleRef.current = next;
      setNavStale(previous => (previous === next ? previous : next));
    };
    update();
    return navigationRef.addListener('state', update);
  }, [navigationRef]);

  const settled = settledSegmentsKey === segmentsKey && navStale === false;

  // The telemetry generation only changes on the sign-in/sign-out transition,
  // which is also when the owner store publishes. Subscribe to that store
  // instead of polling the generation counter for the life of the process.
  const owner = useSyncExternalStore(subscribeAuthenticatedOwner, getAuthenticatedOwner);

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
    // `owner` is the transition signal; the generation is read fresh here
    // because the telemetry controller exposes no subscription.
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
  }, [owner, segments, settled, analyticsReady, bootstrapSettled, postHogClientGeneration]);
}

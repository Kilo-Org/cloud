import { useNavigationContainerRef, useSegments } from 'expo-router';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { captureScreen, isPostHogReady, subscribeToPostHogReady } from '@/lib/analytics/posthog';
import {
  decideScreenTracking,
  SCREEN_TRACKING_SETTLE_DEBOUNCE_MS,
  type ScreenTrackingCapture,
} from '@/lib/hooks/screen-tracking-decision';
import { publishSettledLeafRoute } from '@/lib/route-lifecycle';
import { allowsOptional, currentGeneration } from '@/lib/telemetry/controller';

// How often the hook polls the telemetry generation counter. The controller
// exposes no subscription and account switches are rare; a short poll keeps the
// new account's first settled leaf captured without coupling to PostHog
// readiness or a manual rerender.
export const SCREEN_TRACKING_GENERATION_POLL_MS = 500;

/**
 * Captures a PostHog `$screen` event for the settled visible leaf route.
 *
 * A route only counts as settled when the navigation state is not stale and
 * the segments stayed unchanged for `SCREEN_TRACKING_SETTLE_DEBOUNCE_MS`.
 * The settled marker is invalidated on every segment change, so even a
 * previously settled leaf that is revisited within the window gets a fresh
 * quiet period before it can capture or publish again. Hidden redirects flip
 * segments immediately, so transient routes never survive the window.
 * `analyticsReady` comes from the PostHog readiness subscription, so a late
 * client init still captures the first settled leaf. The capture is accepted
 * only when the ready PostHog client belongs to the current account
 * generation — a stale client silently drops events, so it never consumes the
 * new generation's dedupe slot. `bootstrapSettled` is the layout's
 * consent-settled boolean.
 *
 * The settled leaf is also published to the shared route-lifecycle signal,
 * independent of analytics eligibility: that signal is a visibility contract
 * for other consumers, not a capture gate.
 *
 * Screen names keep their bracket placeholders (e.g. `chat/[sandbox-id]`), so
 * no IDs or other dynamic values ever leave the device. In dev builds each
 * capture is logged as `[screen-tracking] <name>` so bot E2E can assert the
 * captured leaves (PostHog is disabled in dev builds).
 */
export function useScreenTracking(bootstrapSettled: boolean): void {
  const segments = useSegments();
  const analyticsReady = useSyncExternalStore(subscribeToPostHogReady, isPostHogReady);
  const lastCapturedRef = useRef<ScreenTrackingCapture | null>(null);

  // Start a fresh settle window on every segment change and invalidate the
  // previous window's settled marker immediately. Without the invalidation a
  // route that settled earlier and is revisited within the window would
  // inherit the old marker and count as settled before its own quiet period
  // elapses: every segment change gets a full settle window.
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

  // Navigation readiness is a subscription, not a one-shot read:
  // `useRootNavigationState` returns a static snapshot, so a stale-to-false
  // transition would never re-evaluate without a manual rerender. Subscribe to
  // the navigation container's `state` events and read the root state on each
  // one. The cast widens the runtime state shape; oxlint's
  // no-unnecessary-condition resolves the optional chain.
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

  // Publish the settled leaf to the shared route-lifecycle signal. This is a
  // visibility signal, so it fires for every settled leaf regardless of
  // analytics readiness or consent.
  useEffect(() => {
    if (!settled) {
      return;
    }
    const leaf = segments.join('/');
    if (leaf === '') {
      return;
    }
    publishSettledLeafRoute(leaf);
  }, [settled, segments]);

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

  // The generation of the PostHog client that is currently ready. The client
  // generation is not exported by the analytics module, so it is observed at
  // the moment readiness becomes true: `initPostHog` records the generation
  // immediately before notifying readiness. `captureScreen` silently drops
  // events when the client's generation does not match the current account
  // generation, so a capture is only accepted (and only marks the dedupe key)
  // when the ready client belongs to the current generation.
  const [postHogClientGeneration, setPostHogClientGeneration] = useState<number | null>(() =>
    isPostHogReady() ? currentGeneration() : null
  );
  useEffect(() => {
    if (isPostHogReady()) {
      setPostHogClientGeneration(currentGeneration());
    }
  }, [analyticsReady]);

  // Decide and capture. Re-evaluates when analytics becomes ready or its
  // client generation is observed, the account generation changes, or a
  // segment change re-settles, so the first settled leaf is captured rather
  // than dropped.
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

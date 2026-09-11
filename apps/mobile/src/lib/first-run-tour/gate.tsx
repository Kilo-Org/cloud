import { useEffect, useRef } from 'react';
import { type Href, useRouter, useSegments } from 'expo-router';

import { useAuth } from '@/lib/auth/auth-context';
import {
  hasRecordedFirstRunTourOutcome,
  loadFirstRunTourDecision,
} from '@/lib/first-run-tour/tour-state';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';

/**
 * Auto-opens the first-run tour on an account's first sign-in, and never
 * again once a decision (done or skipped) exists.
 *
 * The decision is a per-account SecureStore record
 * (`@/lib/first-run-tour/tour-state`), the same class as the consent records.
 * RootLayoutNav lives in the process-lifetime root
 * layout and does NOT remount on sign-out → sign-in, so the push is keyed to
 * the Home visit (below): a second account signed into in the same process,
 * and a re-sign-in without a decision, still get their own tour.
 *
 * The stored decision alone is not enough to stop a re-open: the read is
 * async, and a dismissal that JUST recorded its outcome may still have its
 * write in flight (or lost to a failed native write, which reads as null by
 * design). The gate therefore also consults the process-lifetime outcome
 * latch (`hasRecordedFirstRunTourOutcome`), which the mark sets
 * synchronously — measured live: after a hardware-back dismissal the gate
 * re-armed on the home re-arrival and re-opened the dismissed tour 10 s
 * later, because its decision read raced the in-flight skip (2026-09-07).
 * The latch is process-lifetime, so it never overrides a stored decision for
 * a LATER sign-in; it only stops this process from re-opening a tour this
 * process already saw dismissed.
 *
 * A failed or corrupt read loads as null, which fails open toward showing
 * the tour again: the worst case is a re-run, while failing closed could
 * hide the tour forever with no user action that re-reads the value.
 *
 * The caller owns when the gate may fire (`enabled`); see the mount in
 * `app/_layout.tsx`, which holds it off until the bootstrap has settled so
 * the push cannot race the bootstrap redirects away.
 *
 * The push fires as soon as home is the settled route and `enabled` has
 * released, gated only by the decision read itself. There is deliberately no
 * extra hold: earlier rounds keyed one to the e2e login helper's
 * prompt-settling tail, which swallowed real skips; the harness now observes
 * first-sign-in behavior BEFORE dismissing any prompt through the login hook
 * (`KILO_E2E_AFTER_LOGIN_FLOW`, see e2e/AGENTS.md), so a tour the helper's
 * automatic dismissal then taps away is a real dismissal the product must
 * persist (owner, 2026-09-08). No delay is keyed to any harness timing.
 *
 * The one-shot is per Home visit, not per sign-in: leaving home (the push
 * landing, or a navigation away) releases it, so a tour that was removed
 * without recording a decision — a programmatic deep-link navigation, see
 * the back guard — re-opens on the next home arrival. A removal that DID
 * record one (Skip, Finish, hardware back) is stopped by the stored decision
 * read and, while that write is still in flight, by the outcome latch.
 */

/** Segments of the home tab, as `useSegments()` reports them (token form). */
const HOME_TAB_SEGMENTS = '(app)/(tabs)/(0_home)';

export function FirstRunTourGate({ enabled }: Readonly<{ enabled: boolean }>): null {
  const { token, isSigningOut } = useAuth();
  const { userId, isLoading } = useCurrentUserId({ enabled: token != null });
  const segments = useSegments();
  const router = useRouter();
  // One push per Home visit: set when the tour is pushed, released when the
  // route leaves home (the push landed, or the user/deep link navigated away)
  // or the token clears. While it is set, the visit's tour is either on
  // screen or was dismissed with a decision the next read will find.
  const pushedForVisitRef = useRef(false);
  const onHome = segments.join('/') === HOME_TAB_SEGMENTS;

  useEffect(() => {
    if (token == null || !onHome) {
      pushedForVisitRef.current = false;
      return undefined;
    }
    if (!enabled || isSigningOut || isLoading || !userId || pushedForVisitRef.current) {
      return undefined;
    }
    let cancelled = false;

    const evaluate = async (): Promise<void> => {
      // An outcome recorded in this process (this sign-in session) vetoed the
      // tour before the read: a just-dismissed tour must not re-open, even
      // while its write is still in flight. The cleanup cannot have run yet
      // (evaluate is invoked synchronously by the effect above), so only the
      // latch is checked here.
      if (hasRecordedFirstRunTourOutcome(userId)) {
        return;
      }
      const decision = await loadFirstRunTourDecision(userId);
      if (
        cancelled ||
        decision !== null ||
        // The read raced a dismissal that latched the outcome (or lost its
        // write): the latch is the authority for this process.
        hasRecordedFirstRunTourOutcome(userId) ||
        pushedForVisitRef.current
      ) {
        return;
      }
      pushedForVisitRef.current = true;
      router.push('/(app)/first-run-tour' as Href);
    };
    void evaluate();

    return () => {
      cancelled = true;
    };
  }, [enabled, isSigningOut, isLoading, userId, router, token, onHome]);

  return null;
}

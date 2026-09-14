import { type Href, usePathname, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';

import { subscribeToConsentChanges } from '@/lib/consent';
import { checkConsentGate } from '@/lib/consent-gate';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useTourCompletion } from '@/lib/tour/tour-completion';

const TOUR_ROUTE = '/(app)/tour';

/** The tour pathname as expo-router reports it, with and without its group. */
const TOUR_PATHNAMES = new Set<string>([TOUR_ROUTE, '/tour']);

/**
 * The pre-app consent gate. Its bootstrap guard redirects back to the gate
 * whenever the account still needs consent and the current route is not the
 * gate, so a tour push from it is replaced back within a frame.
 */
const CONSENT_PATHNAMES = new Set<string>(['/consent', '/(app)/consent', '/consent-details']);

type ConsentGateState = 'unknown' | 'pending' | 'accepted';

/**
 * Whether the consent gate still stands between this account and the app shell.
 *
 * `true` until the account's decision has been read, and again whenever it is
 * read as unaccepted. Holding on the gate STATE — not only on a consent
 * pathname — is what keeps the once-only marker safe: on a cold start the app
 * shell can mount at Home while the gate is still loading, and the bootstrap
 * guard replaces anything pushed there back to `/consent`, so a push made in
 * that window would consume the marker and suppress the tour for the session.
 */
function useConsentPending(userId: string | undefined): boolean {
  const [decision, setDecision] = useState<{ userId: string | undefined; state: ConsentGateState }>(
    {
      userId: undefined,
      state: 'unknown',
    }
  );

  useEffect(() => {
    if (userId === undefined) {
      setDecision({ userId: undefined, state: 'unknown' });
      return undefined;
    }
    setDecision({ userId, state: 'unknown' });

    let cancelled = false;

    const readDecision = async () => {
      const result = await checkConsentGate(userId);
      if (cancelled) {
        return;
      }
      setDecision({ userId, state: result.status === 'accepted' ? 'accepted' : 'pending' });
    };
    void readDecision();
    // A consent write (the gate being answered) releases the hold immediately.
    const unsubscribe = subscribeToConsentChanges(change => {
      if (change.userId === userId) {
        setDecision({ userId, state: change.hasAccepted ? 'accepted' : 'pending' });
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [userId]);

  // A decision read for another account never counts for this one.
  return decision.userId !== userId || decision.state !== 'accepted';
}

/**
 * Auto-opens the first-sign-in tour exactly once per account.
 *
 * Fires only when a user id is present, the stored decision has loaded, the
 * account has not already finished or skipped the tour, the consent gate has
 * been answered, and the tour route is not already on screen. A ref keyed by
 * user id makes the push once-only for that account, so later renders (and
 * later sign-ins of the same account) never re-open it — the persisted
 * decision reinforces that for a fresh mount.
 * Returns null; it is mounted in the `(app)` layout beside the other mounts.
 *
 * A brand-new account signs in behind the consent gate, which is shown until
 * the person answers it. The gate cannot host the tour: its bootstrap guard
 * replaces any other route back to itself while consent is pending, so a push
 * from the gate is undone within a frame. This component therefore waits for
 * the gate rather than consuming its once-only marker on it — marking the
 * account opened there would suppress the first-sign-in tour for the whole
 * session, and the tour would only surface on some later cold start. The wait
 * follows the consent DECISION, so it also covers a cold start that mounts the
 * shell at Home while the gate is still loading.
 */
export function TourAutoOpen() {
  const router = useRouter();
  const pathname = usePathname();
  const { userId } = useCurrentUserId();
  const { isLoaded, isCompleted } = useTourCompletion(userId);
  const consentPending = useConsentPending(userId);
  const openedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!userId || !isLoaded || isCompleted || consentPending) {
      return;
    }
    // Already opened for this account, or the tour is on screen (an explicit
    // Profile open): mark it opened so we never push behind the person later.
    if (openedForRef.current === userId) {
      return;
    }
    // Hold the once-only marker until the consent gate has been answered: a
    // push from the gate is bounced back by the bootstrap guard.
    if (CONSENT_PATHNAMES.has(pathname)) {
      return;
    }
    openedForRef.current = userId;
    if (TOUR_PATHNAMES.has(pathname)) {
      return;
    }
    router.push(TOUR_ROUTE as Href);
  }, [userId, isLoaded, isCompleted, consentPending, pathname, router]);

  return null;
}

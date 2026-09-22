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
 * The pre-app consent gate. A push fired from the gate itself is bounced back
 * by its bootstrap guard within a frame, so the component never pushes while
 * the gate route is on screen. The primary hold is the account's consent
 * state (`useConsentGateState`): the gate can still redirect to the gate
 * route even when this component is mounted on a normal one.
 */
const CONSENT_PATHNAMES = new Set<string>(['/consent', '/(app)/consent', '/consent-details']);

/** Where the account stands against the pre-app consent gate. */
type ConsentGateState = 'loading' | 'pending' | 'accepted';

/**
 * The account's consent-gate state, read from the same SecureStore record the
 * bootstrap gate answers. `pending` until the record exists; a failed read
 * also holds at `pending`, because unknown must never consume the once-only
 * marker. The change subscription re-reads when the person answers the gate,
 * so the hold releases as the bootstrap redirect out of the gate lands.
 */
function useConsentGateState(userId: string | undefined): ConsentGateState {
  const [state, setState] = useState<ConsentGateState>('loading');
  useEffect(() => {
    // Never inherit the previous account's answer across a switch.
    setState('loading');
    if (userId === undefined) {
      return undefined;
    }
    let cancelled = false;
    const read = async () => {
      const result = await checkConsentGate(userId);
      if (cancelled) {
        return;
      }
      setState(result.status === 'accepted' ? 'accepted' : 'pending');
    };
    void read();
    const unsubscribe = subscribeToConsentChanges(change => {
      if (change.userId === userId) {
        void read();
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [userId]);
  return state;
}

/**
 * Auto-opens the first-sign-in tour exactly once per account.
 *
 * Fires only when a user id is present, the stored decision has loaded, the
 * account has not already finished or skipped the tour, the account's consent
 * gate has been answered, and the tour route is not already on screen. A ref
 * keyed by user id makes the push once-only for that account, so later
 * renders (and later sign-ins of the same account) never re-open it — the
 * persisted decision reinforces that for a fresh mount. Returns null; it is
 * mounted in the `(app)` layout beside the other mounts.
 *
 * A brand-new account signs in behind the consent gate, which is shown until
 * the person answers it. The gate cannot host the tour: its bootstrap guard
 * replaces any other route back to itself while consent is pending, so a push
 * from the gate is undone within a frame. The component therefore holds its
 * once-only marker until the account's consent record exists — the gate can
 * also still be ahead of the person on a cold start that relaunches mid-gate,
 * where the tree mounts on a normal route before the redirect to the gate
 * lands. Marking the account opened there would suppress the first-sign-in
 * tour for the whole session, and the tour would only surface on some later
 * cold start.
 */
export function TourAutoOpen() {
  const router = useRouter();
  const pathname = usePathname();
  const { userId } = useCurrentUserId();
  const { isLoaded, isCompleted } = useTourCompletion(userId);
  const consentGate = useConsentGateState(userId);
  const openedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!userId || !isLoaded || isCompleted) {
      return;
    }
    // Already opened for this account, or the tour is on screen (an explicit
    // Profile open): mark it opened so we never push behind the person later.
    if (openedForRef.current === userId) {
      return;
    }
    // Hold the once-only marker while the account still owes consent: a push
    // now is bounced back by the bootstrap guard.
    if (consentGate !== 'accepted') {
      return;
    }
    // Never push from the gate itself: the answer's redirect out of the gate
    // can still be a frame away, and a push from the gate is bounced.
    if (CONSENT_PATHNAMES.has(pathname)) {
      return;
    }
    openedForRef.current = userId;
    if (TOUR_PATHNAMES.has(pathname)) {
      return;
    }
    router.push(TOUR_ROUTE as Href);
  }, [userId, isLoaded, isCompleted, consentGate, pathname, router]);

  return null;
}

import { type Href, usePathname, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';

import { subscribeToConsentChanges } from '@/lib/consent';
import { checkConsentGate } from '@/lib/consent-gate';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import {
  claimTourAutoOpenAttempt,
  isTourAutoOpenAttemptSpent,
  spendTourAutoOpenAttempt,
} from '@/lib/tour/tour-auto-open-boot';
import { useTourCompletion } from '@/lib/tour/tour-completion';
import { useTourGatewayUsage } from '@/lib/tour/use-tour-gate-usage';

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
 * Auto-opens the first-sign-in tour once per account, on a cold boot only, and
 * only for an account with zero Kilo gateway usage.
 *
 * Current behaviour before this change: the component is mounted
 * unconditionally (`apps/mobile/src/app/(app)/_layout.tsx`) and pushed the tour
 * once per account after consent, for every account. There is no tour feature
 * flag or build config. The only permanent suppressions are the per-account
 * completion record and an unanswered consent gate, so the owner's "never
 * shown" reading is account-local state, not a code path. This change adds the
 * zero-usage condition and restricts the automatic open to the launch that
 * created this JS process.
 *
 * Fires only when a user id is present, the stored decision has loaded, the
 * account has not already finished or skipped the tour, the account's consent
 * gate has been answered, the tour route is not already on screen, this
 * process has not spent its one attempt, and the server has answered that the
 * account has no gateway usage. A ref keyed by user id makes the push
 * once-only for that account, so later renders (and later sign-ins of the same
 * account) never re-open it — the persisted decision reinforces that for a
 * fresh mount. The attempt is bound to the first account this process sees, so
 * a warm account switch after a held launch cannot auto-open either. Returns
 * null; it is mounted in the `(app)` layout beside the other mounts.
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
 *
 * Usage unknown (loading or failed) also holds without spending the attempt,
 * so a later success in the same launch can still open the tour for a
 * zero-usage account; a used account is never opened on an unknown value.
 */
export function TourAutoOpen() {
  const router = useRouter();
  const pathname = usePathname();
  const { userId } = useCurrentUserId();
  const { isLoaded, isCompleted } = useTourCompletion(userId);
  const consentGate = useConsentGateState(userId);
  const { isLoaded: usageLoaded, hasUsage } = useTourGatewayUsage(
    userId,
    !isTourAutoOpenAttemptSpent()
  );
  const openedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!userId) {
      return;
    }
    if (openedForRef.current === userId) {
      return;
    }
    // One automatic attempt per app process. A warm (app) entry or a resume
    // must never auto-open; only the launch that created this process may.
    if (isTourAutoOpenAttemptSpent()) {
      return;
    }
    // The process has one automatic attempt, and it belongs to the launch
    // account: the first account this gate saw after a cold boot. A warm
    // account switch — including a sign-out, which unmounts the (app) tree, and
    // a different sign-in, which remounts it — must not inherit the attempt, so
    // spend it there. The binding lives in the boot marker's module state, not a
    // ref, so the remount cannot mistake the second account for the launch
    // account. The launch account's own completion, consent, or usage hold
    // still keeps the attempt for a later success in this same launch.
    if (!claimTourAutoOpenAttempt(userId)) {
      spendTourAutoOpenAttempt();
      return;
    }
    if (!isLoaded) {
      return;
    }
    // An account that finished the tour can never auto-open; spend the attempt
    // so an account switch later in this same process cannot either.
    if (isCompleted) {
      spendTourAutoOpenAttempt();
      return;
    }
    if (consentGate !== 'accepted') {
      return;
    }
    if (CONSENT_PATHNAMES.has(pathname)) {
      return;
    }
    // An explicit Profile open put the tour on screen: consume the launch
    // attempt so it never pushes behind the person later in this process.
    if (TOUR_PATHNAMES.has(pathname)) {
      openedForRef.current = userId;
      spendTourAutoOpenAttempt();
      return;
    }
    // Usage unknown (loading or failed): hold. Never spend the attempt or push
    // on an unknown, or a used account could open the tour.
    if (!usageLoaded) {
      return;
    }
    openedForRef.current = userId;
    spendTourAutoOpenAttempt();
    if (hasUsage) {
      return;
    }
    router.push(TOUR_ROUTE as Href);
  }, [userId, isLoaded, isCompleted, consentGate, pathname, router, usageLoaded, hasUsage]);

  return null;
}

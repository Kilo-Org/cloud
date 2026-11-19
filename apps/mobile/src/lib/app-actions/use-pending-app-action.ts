// The in-app consumer for an action another surface asked for.
//
// The URL rails park a request (`action-url-handler.ts`), a completed
// StartAgent parks the session it created, and this hook — mounted by the tabs
// layout, the one place that holds both the router and the live session list —
// answers it: navigate to the destination, run the StartAgent, or report the
// contract's refusal for an input that names no destination.

import { useRouter } from 'expo-router';
import { useEffect, useSyncExternalStore } from 'react';
import { toast } from 'sonner-native';

import { announceTrialRefusal } from '@/lib/refusal-toast';
import { useBillingAction, useCanManageBilling } from '@/lib/trial-refusal';
import { trialRefusalMessage } from '@/lib/trial-refusal-copy';

import {
  appActionHref,
  type NeedsInputSession,
  resolveNeedsInputHref,
} from './app-action-contract';
import { dispatchAppActionRequest, unresolvedOpenActionRefusal } from './app-action-dispatch';
import {
  getPendingAppAction,
  subscribePendingAppAction,
  takePendingAppAction,
} from './pending-app-action';

/**
 * Consume one parked app action once the shell can answer it.
 *
 * Each branch takes the request before it acts, so a later back-gesture or an
 * unrelated re-render cannot re-fire it. A resolved open action shows no error
 * of its own: the destination screen's own loading, error/retry and empty
 * states are the states of the action. An open action whose input names no
 * destination never reaches a screen, so the consumer reports the contract's
 * refusal itself — the one error this surface owns: non-retryable, no CTA and
 * no navigation, because the app is already at the front on the screen it was
 * showing, and correcting the link is the fix.
 *
 * A `StartAgent` the OS asked for through a URL runs once the shell is up. A
 * failure is the app's own feedback — `AGENTS.md` has every failed mutation
 * show `result.message` — because this hook owns no screen of its own to show
 * it. The trial refusal is the one exception: the OS path carries no
 * organization, so it maps the member sentence, and the copy is re-derived
 * here from the same role read that decides the step, keeping both on one
 * reader. The confirmation a run has to pass first shows the person the
 * request, so its cancel answer reports nothing here.
 */
export function usePendingAppAction({
  isError,
  isLoading,
  needsInputRows,
  orgLoaded,
}: {
  isError: boolean;
  isLoading: boolean;
  needsInputRows: readonly NeedsInputSession[];
  orgLoaded: boolean;
}): void {
  const router = useRouter();
  // The step a refusal offers: an OS request names no organization, so the
  // role is the selected one — the reader every surface paints without an
  // organization override. Read here, not in the effect, which runs later.
  const billingAction = useBillingAction();
  // The same predicate `billingAction` resolves, read beside it so the copy a
  // trial refusal announces on this surface matches the step it offers.
  const canManageBilling = useCanManageBilling();
  const pendingAppAction = useSyncExternalStore(subscribePendingAppAction, getPendingAppAction);
  useEffect(() => {
    if (pendingAppAction === null) {
      return;
    }
    // Wait for the live list to settle before answering "the one waiting
    // session, or the list" — and treat a failed query as settled, because the
    // list screen owns that error and its retry.
    if (pendingAppAction.action === 'OpenNeedsInput' && !(orgLoaded && (!isLoading || isError))) {
      return;
    }
    // Act on what this run consumed, not on the snapshot it rendered with: an
    // effect replay (StrictMode) or a concurrent arrival can consume the slot
    // between this render and this run, and a second navigate or a second
    // StartAgent would be a real duplicate.
    const request = takePendingAppAction();
    if (request === null) {
      return;
    }
    const href =
      request.action === 'OpenNeedsInput'
        ? resolveNeedsInputHref(needsInputRows)
        : appActionHref(request);
    if (href !== null) {
      router.navigate(href);
      return;
    }
    if (request.action === 'StartAgent') {
      void (async () => {
        const result = await dispatchAppActionRequest(request);
        if (!result.ok && result.code !== 'start-cancelled') {
          // The OS path maps the member sentence because it cannot read a
          // role, so a trial refusal's copy is re-derived at announce time
          // from the same role read that decides the step.
          const isTrialRefusal = result.trialRefusal === true;
          announceTrialRefusal(
            isTrialRefusal ? trialRefusalMessage(canManageBilling) : result.message,
            billingAction,
            isTrialRefusal
          );
        }
      })();
      return;
    }
    // An open action whose input names no destination never reaches a screen,
    // so the consumer reports the contract's refusal: non-retryable, no CTA
    // and no navigation — correcting the link is the fix.
    const refusal = unresolvedOpenActionRefusal(request);
    if (refusal !== null) {
      toast.error(refusal.message);
    }
  }, [
    pendingAppAction,
    orgLoaded,
    isLoading,
    isError,
    needsInputRows,
    router,
    billingAction,
    canManageBilling,
  ]);
}

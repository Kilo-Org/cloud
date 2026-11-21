import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

import { ENDED_STATUSES } from '@/lib/kilo-pass/state';

type RouterOutputs = inferRouterOutputs<MobileRouter>;

/** A live pass, as `kiloPass.getState` reports it. */
export type KiloPassSubscriptionState = NonNullable<
  RouterOutputs['kiloPass']['getState']['subscription']
>;

export type KiloPassBillingEntry =
  RouterOutputs['kiloPass']['getBillingHistory']['entries'][number];

export type KiloPassCreditEntry = RouterOutputs['kiloPass']['getCreditHistory']['entries'][number];

/** Which management action the app can offer for this pass, if any. */
export type KiloPassManagementAction = 'cancel' | 'resume-cancelled' | 'resume-paused' | 'none';

/**
 * The one action the pass needs, chosen from the state its provider reports.
 *
 * A pass the App Store or Play sold has no action here: the server rejects every
 * Stripe control for it, and Kilo Pass is no longer sold in either store, so
 * nothing in the app changes it. The order matches the web console — a pause
 * outranks a pending cancellation, which outranks cancelling.
 */
export function selectKiloPassManagementAction(subscription: {
  paymentProvider: string;
  status: string;
  cancelAtPeriodEnd: boolean;
}): KiloPassManagementAction {
  if (subscription.paymentProvider !== 'stripe') {
    return 'none';
  }
  if (ENDED_STATUSES.has(subscription.status)) {
    return 'none';
  }
  if (subscription.status === 'paused') {
    return 'resume-paused';
  }
  if (subscription.cancelAtPeriodEnd) {
    return 'resume-cancelled';
  }
  return subscription.status === 'active' ? 'cancel' : 'none';
}

/** Whether the pass was sold by a store rather than by kilo.ai's own checkout. */
export function isStoreManagedPass(subscription: { paymentProvider: string }): boolean {
  return subscription.paymentProvider !== 'stripe';
}

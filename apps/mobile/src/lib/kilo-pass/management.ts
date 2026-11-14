import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

import { WEB_BASE_URL } from '@/lib/config';
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
 * A pass the App Store or Play sold is managed in that store: the server
 * rejects every Stripe control for it, so the screen offers the store's own
 * settings page instead of an action here. The order matches the web console —
 * a pause outranks a pending cancellation, which outranks cancelling.
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

/** Which store sold a store-managed pass. Only meaningful when one did. */
export function isAppStorePass(subscription: { paymentProvider: string }): boolean {
  return subscription.paymentProvider === 'app_store';
}

const APP_STORE_SUBSCRIPTIONS_URL = 'https://apps.apple.com/account/subscriptions';
const GOOGLE_PLAY_SUBSCRIPTIONS_URL = 'https://play.google.com/store/account/subscriptions';

/** The web console's Kilo Pass page, where a paid plan change happens. */
export function kiloPassWebUrl(): string {
  return `${WEB_BASE_URL}/subscriptions/kilo-pass`;
}

/**
 * The store page where the pass is cancelled or changed. A store-sold pass has
 * no controls in this app or on kilo.ai, so that page is where management
 * lives.
 */
export function storeSubscriptionsUrl(paymentProvider: string): string {
  return paymentProvider === 'app_store'
    ? APP_STORE_SUBSCRIPTIONS_URL
    : GOOGLE_PLAY_SUBSCRIPTIONS_URL;
}

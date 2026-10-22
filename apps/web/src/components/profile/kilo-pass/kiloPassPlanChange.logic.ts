import type { KiloPassSubscription } from './kiloPassSubscription';

export function getPlanChangeBlockedReason(
  subscription: Pick<KiloPassSubscription, 'status' | 'cancelAtPeriodEnd'>
): string | null {
  if (subscription.status === 'active' && subscription.cancelAtPeriodEnd) {
    return 'Your Kilo Pass is set to cancel. Resume your subscription before changing plans.';
  }
  return null;
}

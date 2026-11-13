import { isKiloPassSubscriptionEndedStatus } from '@kilocode/worker-utils/kilo-pass-bonus-projection';

export function isStripeSubscriptionEnded(status: string): boolean {
  return isKiloPassSubscriptionEndedStatus(status);
}

import { describe, expect, it } from 'vitest';
import type { StripeSubscriptionStatus } from '@kilocode/db/schema-types';
import {
  isKiloPassSubscriptionEndedStatus,
  type KiloPassEndedSubscriptionStatus,
} from './kilo-pass-bonus-projection';

describe('kilo pass ended status', () => {
  it('classifies the terminal statuses and nothing else', () => {
    expect(isKiloPassSubscriptionEndedStatus('canceled')).toBe(true);
    expect(isKiloPassSubscriptionEndedStatus('unpaid')).toBe(true);
    expect(isKiloPassSubscriptionEndedStatus('incomplete_expired')).toBe(true);
    expect(isKiloPassSubscriptionEndedStatus('active')).toBe(false);
    expect(isKiloPassSubscriptionEndedStatus('past_due')).toBe(false);
    expect(isKiloPassSubscriptionEndedStatus('paused')).toBe(false);
    // A status a newer provider version may return is not ended.
    expect(isKiloPassSubscriptionEndedStatus('unknown-status')).toBe(false);
  });

  it('narrows its argument to the ended statuses', () => {
    const status: StripeSubscriptionStatus = 'unpaid';

    // Keeps the predicate a type guard. A plain `boolean` return leaves `status`
    // as the open provider union, which is not assignable to the ended set.
    const ended: KiloPassEndedSubscriptionStatus | null = isKiloPassSubscriptionEndedStatus(status)
      ? status
      : null;

    expect(ended).toBe('unpaid');
  });

  it('rejects a status outside the ended set at compile time', () => {
    // @ts-expect-error 'active' is not an ended status.
    const notEnded: KiloPassEndedSubscriptionStatus = 'active';

    expect(notEnded).toBe('active');
  });
});

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
    expect(isKiloPassSubscriptionEndedStatus('unknown-status')).toBe(false);
  });

  it('keeps a narrow signature so the ended set stays checked', () => {
    const statuses: StripeSubscriptionStatus[] = ['canceled', 'unpaid', 'incomplete_expired'];

    // A type guard narrows the argument to the ended union here. Widening the
    // return to `boolean` leaves the open provider union instead, which is not
    // assignable to `KiloPassEndedSubscriptionStatus`, so this line fails the
    // package typecheck rather than passing silently at runtime.
    const ended = statuses.map(status =>
      isKiloPassSubscriptionEndedStatus(status) ? status : null
    ) satisfies (KiloPassEndedSubscriptionStatus | null)[];

    expect(ended).toEqual(['canceled', 'unpaid', 'incomplete_expired']);

    // The ended union is closed, so a live status cannot be assigned to it.
    // Removing either guard above makes this directive unused (TS2578) or the
    // assignment legal, and the package typecheck reports it.
    // @ts-expect-error 'active' is not an ended status.
    const notEnded: KiloPassEndedSubscriptionStatus = 'active';
    expect(isKiloPassSubscriptionEndedStatus(notEnded)).toBe(false);
  });
});

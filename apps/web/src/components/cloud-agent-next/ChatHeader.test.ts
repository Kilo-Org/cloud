import { describe, expect, it } from '@jest/globals';
import { computeBillingLabel, computeBillingRefetchInterval } from './ChatHeader';

const active = {
  billingMode: 'paid' as const,
  phase: 'active' as const,
  estimatedHourlyRateMicrodollars: null,
  estimatedIntervalAmountMicrodollars: null,
};

describe('computeBillingLabel', () => {
  it.each([
    ['payer_shared', 'Shared compute so far · pricing unavailable'],
    ['session', 'Compute so far · pricing unavailable'],
  ] as const)('does not show $0.00 when active %s pricing is unavailable', (attribution, label) => {
    expect(computeBillingLabel({ ...active, attribution })).toBe(label);
  });
});

describe('computeBillingRefetchInterval', () => {
  it('stops polling while idle and resumes when the live session becomes active', () => {
    expect(computeBillingRefetchInterval(false, 'idle')).toBe(false);
    expect(computeBillingRefetchInterval(true, 'idle')).toBe(5_000);
  });
});

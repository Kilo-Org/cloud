import type Stripe from 'stripe';
import {
  addOneMonthToIssueMonth,
  getInvoiceIssueMonth,
  getInvoiceSubscription,
  getPreviousIssueMonth,
  getStripeEndedAtIso,
} from './stripe-handlers-utils';
import { isStripeSubscriptionEnded } from '@/lib/kilo-pass/stripe-subscription-status';

describe('addOneMonthToIssueMonth', () => {
  it('adds one month to a mid-year month', () => {
    expect(addOneMonthToIssueMonth('2025-06-01')).toBe('2025-07-01');
  });

  it('handles year boundary (December to January)', () => {
    expect(addOneMonthToIssueMonth('2025-12-01')).toBe('2026-01-01');
  });

  it('handles January', () => {
    expect(addOneMonthToIssueMonth('2025-01-01')).toBe('2025-02-01');
  });

  it('throws on invalid issueMonth format', () => {
    expect(() => addOneMonthToIssueMonth('invalid')).toThrow('Invalid issueMonth: invalid');
  });

  it('throws on empty string', () => {
    expect(() => addOneMonthToIssueMonth('')).toThrow('Invalid issueMonth: ');
  });
});

describe('getPreviousIssueMonth', () => {
  it('gets previous month for mid-year', () => {
    expect(getPreviousIssueMonth('2025-06-01')).toBe('2025-05-01');
  });

  it('handles year boundary (January to December)', () => {
    expect(getPreviousIssueMonth('2025-01-01')).toBe('2024-12-01');
  });

  it('handles December', () => {
    expect(getPreviousIssueMonth('2025-12-01')).toBe('2025-11-01');
  });

  it('throws on invalid issueMonth format', () => {
    expect(() => getPreviousIssueMonth('not-a-date')).toThrow('Invalid issueMonth: not-a-date');
  });
});

describe('getInvoiceIssueMonth', () => {
  it('uses subscription line item period.start when available', () => {
    const invoice = {
      id: 'inv_123',
      period_start: 1733011200, // 2024-12-01 (previous period — should be ignored)
      created: 1735776000, // 2025-01-02
      lines: {
        data: [
          {
            parent: { subscription_item_details: { subscription_item: 'si_abc' } },
            period: { start: 1735689600, end: 1738368000 }, // 2025-01-01 to 2025-02-01
          },
        ],
      },
    } as unknown as Stripe.Invoice;

    expect(getInvoiceIssueMonth(invoice)).toBe('2025-01-01');
  });

  it('falls back to created when no subscription line items exist', () => {
    const invoice = {
      id: 'inv_123',
      period_start: 1733011200,
      created: 1735776000, // 2025-01-02
      lines: { data: [] },
    } as unknown as Stripe.Invoice;

    expect(getInvoiceIssueMonth(invoice)).toBe('2025-01-01');
  });

  it('falls back to created when lines.data is missing', () => {
    const invoice = {
      id: 'inv_123',
      created: 1735776000, // 2025-01-02
    } as unknown as Stripe.Invoice;

    expect(getInvoiceIssueMonth(invoice)).toBe('2025-01-01');
  });

  it('throws when no subscription line item and created is null', () => {
    const invoice = {
      id: 'inv_123',
      created: null,
      lines: { data: [] },
    } as unknown as Stripe.Invoice;

    expect(() => getInvoiceIssueMonth(invoice)).toThrow(
      'Invoice inv_123 has no subscription line item period and no created timestamp'
    );
  });

  it('handles mid-month line item period correctly', () => {
    const invoice = {
      id: 'inv_456',
      period_start: 1734393600,
      created: 1737043200,
      lines: {
        data: [
          {
            parent: { subscription_item_details: { subscription_item: 'si_abc' } },
            period: { start: 1737043200, end: 1739721600 }, // 2025-01-16 to 2025-02-16
          },
        ],
      },
    } as unknown as Stripe.Invoice;

    expect(getInvoiceIssueMonth(invoice)).toBe('2025-01-01');
  });

  it('skips non-subscription line items and uses subscription line item', () => {
    const invoice = {
      id: 'inv_789',
      period_start: 1733011200,
      created: 1735776000,
      lines: {
        data: [
          {
            parent: { invoice_item_details: { invoice_item: 'ii_xyz' } },
            period: { start: 1733011200, end: 1735689600 }, // one-off item from December
          },
          {
            parent: { subscription_item_details: { subscription_item: 'si_abc' } },
            period: { start: 1735689600, end: 1738368000 }, // 2025-01-01 to 2025-02-01
          },
        ],
      },
    } as unknown as Stripe.Invoice;

    expect(getInvoiceIssueMonth(invoice)).toBe('2025-01-01');
  });
});

describe('getInvoiceSubscription', () => {
  it('returns null when no subscription reference exists', async () => {
    const invoice = {
      id: 'inv_123',
      parent: null,
    } as unknown as Stripe.Invoice;

    const mockStripe = {} as Stripe;

    const result = await getInvoiceSubscription({ invoice, stripe: mockStripe });
    expect(result).toBeNull();
  });

  it('returns null when parent exists but subscription_details is missing', async () => {
    const invoice = {
      id: 'inv_123',
      parent: {},
    } as unknown as Stripe.Invoice;

    const mockStripe = {} as Stripe;

    const result = await getInvoiceSubscription({ invoice, stripe: mockStripe });
    expect(result).toBeNull();
  });

  it('always fetches latest subscription from Stripe even when expanded object is provided', async () => {
    const embeddedSubscription = {
      id: 'sub_123',
      status: 'active',
    } as Stripe.Subscription;

    const freshSubscription = {
      id: 'sub_123',
      status: 'canceled',
    } as Stripe.Subscription;

    const invoice = {
      id: 'inv_123',
      parent: {
        subscription_details: {
          subscription: embeddedSubscription,
        },
      },
    } as unknown as Stripe.Invoice;

    const mockStripe = {
      subscriptions: {
        retrieve: jest.fn().mockResolvedValue(freshSubscription),
      },
    } as unknown as Stripe;

    const result = await getInvoiceSubscription({ invoice, stripe: mockStripe });
    // Should return the freshly fetched subscription, not the embedded one
    expect(result).toBe(freshSubscription);
    expect(result?.status).toBe('canceled');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockStripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_123');
  });

  it('fetches subscription from Stripe when only ID is provided', async () => {
    const subscriptionObject = {
      id: 'sub_123',
      status: 'active',
    } as Stripe.Subscription;

    const invoice = {
      id: 'inv_123',
      parent: {
        subscription_details: {
          subscription: 'sub_123',
        },
      },
    } as unknown as Stripe.Invoice;

    const mockStripe = {
      subscriptions: {
        retrieve: jest.fn().mockResolvedValue(subscriptionObject),
      },
    } as unknown as Stripe;

    const result = await getInvoiceSubscription({ invoice, stripe: mockStripe });
    expect(result).toBe(subscriptionObject);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockStripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_123');
  });
});

describe('isStripeSubscriptionEnded', () => {
  it('returns true for canceled status', () => {
    expect(isStripeSubscriptionEnded('canceled')).toBe(true);
  });

  it('returns true for unpaid status', () => {
    expect(isStripeSubscriptionEnded('unpaid')).toBe(true);
  });

  it('returns true for incomplete_expired status', () => {
    expect(isStripeSubscriptionEnded('incomplete_expired')).toBe(true);
  });

  it('returns false for active status', () => {
    expect(isStripeSubscriptionEnded('active')).toBe(false);
  });

  it('returns false for trialing status', () => {
    expect(isStripeSubscriptionEnded('trialing')).toBe(false);
  });

  it('returns false for past_due status', () => {
    expect(isStripeSubscriptionEnded('past_due')).toBe(false);
  });

  it('returns false for incomplete status', () => {
    expect(isStripeSubscriptionEnded('incomplete')).toBe(false);
  });

  it('returns false for paused status', () => {
    expect(isStripeSubscriptionEnded('paused')).toBe(false);
  });
});

describe('getStripeEndedAtIso', () => {
  it('uses ended_at when available', () => {
    const subscription = {
      ended_at: 1735689600, // 2025-01-01 00:00:00 UTC
      canceled_at: 1735603200, // 2024-12-31 00:00:00 UTC
    } as Stripe.Subscription;

    expect(getStripeEndedAtIso(subscription)).toBe('2025-01-01T00:00:00.000Z');
  });

  it('falls back to canceled_at when ended_at is null', () => {
    const subscription = {
      ended_at: null,
      canceled_at: 1735603200, // 2024-12-31 00:00:00 UTC
    } as Stripe.Subscription;

    expect(getStripeEndedAtIso(subscription)).toBe('2024-12-31T00:00:00.000Z');
  });

  it('returns current time when both ended_at and canceled_at are null', () => {
    const subscription = {
      ended_at: null,
      canceled_at: null,
    } as Stripe.Subscription;

    const before = Date.now();
    const result = getStripeEndedAtIso(subscription);
    const after = Date.now();

    const resultTime = new Date(result).getTime();
    expect(resultTime).toBeGreaterThanOrEqual(before);
    expect(resultTime).toBeLessThanOrEqual(after);
  });

  it('returns ISO 8601 formatted string', () => {
    const subscription = {
      ended_at: 1735689600,
      canceled_at: null,
    } as Stripe.Subscription;

    const result = getStripeEndedAtIso(subscription);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

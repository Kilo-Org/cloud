import { describe, expect, it } from 'vitest';

import {
  formatSeatCount,
  getAutoTopUpReadout,
  getOrgSubscriptionState,
  getScheduledSeatChange,
  type OrgSeatSubscription,
} from '@/components/organization/billing-model';

/** 2026-01-01T00:00:00Z, the paid period's end in these cases. */
const PERIOD_END = 1_767_225_600;

function subscription(overrides: Partial<OrgSeatSubscription> = {}): OrgSeatSubscription {
  return {
    subscription: {
      status: 'active',
      cancel_at_period_end: false,
      items: { data: [{ id: 'si_1', current_period_end: PERIOD_END }] },
    },
    seatsUsed: 3,
    totalSeats: 5,
    nextSeatCount: null,
    nextSeatCountEffectiveAt: null,
    paidSeatItemId: 'si_1',
    ...overrides,
  };
}

function withStatus(status: string, cancelAtPeriodEnd = false): OrgSeatSubscription {
  return subscription({
    subscription: {
      status,
      cancel_at_period_end: cancelAtPeriodEnd,
      items: { data: [{ id: 'si_1', current_period_end: PERIOD_END }] },
    },
  });
}

describe('getOrgSubscriptionState', () => {
  it('reports an active subscription renewing on the paid period end', () => {
    const state = getOrgSubscriptionState(subscription());
    expect(state.tone).toBe('good');
    expect(state.label.startsWith('Renews on ')).toBe(true);
    expect(state.label).toContain('2026');
  });

  it('falls back to the bare status when Stripe carried no period end', () => {
    const state = getOrgSubscriptionState(
      subscription({
        subscription: {
          status: 'active',
          cancel_at_period_end: false,
          items: { data: [{ id: 'si_1', current_period_end: null }] },
        },
      })
    );
    expect(state).toEqual({ label: 'Active', tone: 'good' });
  });

  it('reports a cancelling subscription on its last day', () => {
    const state = getOrgSubscriptionState(withStatus('active', true));
    expect(state.tone).toBe('warn');
    expect(state.label.startsWith('Cancels on ')).toBe(true);
  });

  it('reports a cancelling subscription without a date', () => {
    const state = getOrgSubscriptionState(
      subscription({
        subscription: {
          status: 'active',
          cancel_at_period_end: true,
          items: { data: [] },
        },
      })
    );
    expect(state).toEqual({
      label: 'Cancels at the end of the period',
      tone: 'warn',
    });
  });

  it('reports a past-due subscription as the failure it is', () => {
    expect(getOrgSubscriptionState(withStatus('past_due'))).toEqual({
      label: 'Past due',
      tone: 'danger',
    });
  });

  it('reports an incomplete payment and a paused subscription as warnings', () => {
    expect(getOrgSubscriptionState(withStatus('incomplete'))).toEqual({
      label: 'Payment incomplete',
      tone: 'warn',
    });
    expect(getOrgSubscriptionState(withStatus('paused'))).toEqual({
      label: 'Paused',
      tone: 'warn',
    });
  });

  it('reports every terminal status as ended', () => {
    for (const status of ['canceled', 'unpaid', 'incomplete_expired']) {
      expect(getOrgSubscriptionState(withStatus(status))).toEqual({
        label: 'Ended',
        tone: 'muted',
      });
    }
  });

  it('reports a trial on its end date', () => {
    const state = getOrgSubscriptionState(withStatus('trialing'));
    expect(state.tone).toBe('good');
    expect(state.label.startsWith('Trial ends on ')).toBe(true);
  });

  it('reports no subscription at all', () => {
    expect(getOrgSubscriptionState(subscription({ subscription: null }))).toEqual({
      label: 'No subscription',
      tone: 'muted',
    });
  });

  it('does not print an unknown provider status verbatim', () => {
    expect(getOrgSubscriptionState(withStatus('weird_future_status'))).toEqual({
      label: 'Unknown',
      tone: 'muted',
    });
  });

  it('reads the period end from the paid seat item first', () => {
    const state = getOrgSubscriptionState(
      subscription({
        subscription: {
          status: 'active',
          cancel_at_period_end: false,
          items: {
            data: [
              { id: 'si_other', current_period_end: 1_900_000_000 },
              { id: 'si_1', current_period_end: PERIOD_END },
            ],
          },
        },
      })
    );
    expect(state.label).toContain('2026');
  });
});

describe('getScheduledSeatChange', () => {
  it('states the target count and the date the decrease lands', () => {
    const change = getScheduledSeatChange(
      subscription({
        nextSeatCount: 2,
        nextSeatCountEffectiveAt: '2026-01-01T00:00:00.000Z',
      })
    );
    expect(change).not.toBeNull();
    expect(change).toContain('2');
    expect(change).toContain('2026');
  });

  it('has nothing to state when no decrease is pending', () => {
    expect(getScheduledSeatChange(subscription())).toBeNull();
  });

  it('has nothing to state when the date cannot be read', () => {
    expect(
      getScheduledSeatChange(
        subscription({ nextSeatCount: 2, nextSeatCountEffectiveAt: 'not-a-timestamp' })
      )
    ).toBeNull();
  });
});

describe('formatSeatCount', () => {
  it('writes used against total', () => {
    expect(formatSeatCount(3, 5)).toBe('3 / 5');
  });
});

describe('getAutoTopUpReadout', () => {
  it('writes the enabled state with both amounts', () => {
    expect(getAutoTopUpReadout({ enabled: true, amountCents: 5000, thresholdCents: 1000 })).toEqual(
      { enabled: true, status: 'Enabled', amount: '$50.00', threshold: '$10.00' }
    );
  });

  it('writes the disabled state', () => {
    expect(
      getAutoTopUpReadout({ enabled: false, amountCents: 5000, thresholdCents: 1000 }).status
    ).toBe('Disabled');
  });
});

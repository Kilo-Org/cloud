import { describe, expect, it } from 'vitest';

import {
  getOrgKiloPassRowState,
  type OrgKiloPassSummary,
} from '@/components/organization/org-kilo-pass-row-state';
import { i18n } from '@/i18n';
import { formatDate } from '@/lib/format';
import { parseTimestamp } from '@/lib/utils';

function agreement(overrides?: Partial<NonNullable<OrgKiloPassSummary['agreement']>>) {
  return {
    tier: 'tier_49' as const,
    paidSeatCount: 8,
    planVersion: 1,
    paidThrough: null,
    ...overrides,
  };
}

function summary(overrides?: Partial<OrgKiloPassSummary>): OrgKiloPassSummary {
  return {
    state: 'active',
    commercialState: 'active',
    processingCondition: 'ready',
    agreement: agreement(),
    ...overrides,
  };
}

describe('getOrgKiloPassRowState', () => {
  it('summarizes an active agreement with tier label and plural seat grammar', () => {
    const row = getOrgKiloPassRowState({ data: summary(), isError: false });
    expect(row).toEqual({
      subtitle: '$49 · 8 paid seats',
      attention: false,
      action: 'manage',
      actionLabel: null,
      accessibilityHint: 'Opens Kilo Pass management on web.',
      loading: false,
    });
  });

  it('uses singular seat grammar and maps every tier label', () => {
    expect(
      getOrgKiloPassRowState({
        data: summary({ agreement: agreement({ tier: 'tier_19', paidSeatCount: 1 }) }),
        isError: false,
      }).subtitle
    ).toBe('$19 · 1 paid seat');
    expect(
      getOrgKiloPassRowState({
        data: summary({ agreement: agreement({ tier: 'tier_199', paidSeatCount: 2 }) }),
        isError: false,
      }).subtitle
    ).toBe('$199 · 2 paid seats');
  });

  it('routes no agreement / unavailable to setup, not the detail page that throws', () => {
    const row = getOrgKiloPassRowState({
      data: summary({
        state: 'unavailable',
        commercialState: null,
        processingCondition: null,
        agreement: null,
      }),
      isError: false,
    });
    expect(row.subtitle).toBe('Not subscribed');
    expect(row.action).toBe('setup');
    expect(row.accessibilityHint).toBe('Opens Kilo Pass setup on web.');
    expect(row.attention).toBe(false);
    expect(row.loading).toBe(false);
  });

  it('routes every state backed by an agreement to the detail management page', () => {
    const destinations = [
      summary({ state: 'active', commercialState: 'active' }),
      summary({ state: 'cancel_at_period_end', commercialState: 'cancel_at_period_end' }),
      summary({ state: 'pending_payment', commercialState: 'pending_payment' }),
      summary({ state: 'activating', commercialState: null }),
      summary({ state: 'ended', commercialState: 'ended', processingCondition: null }),
      summary({ state: 'blocked', commercialState: 'active', processingCondition: 'blocked' }),
    ];
    for (const data of destinations) {
      const row = getOrgKiloPassRowState({ data, isError: false });
      expect(row.action).toBe('manage');
      expect(row.accessibilityHint).toBe('Opens Kilo Pass management on web.');
    }
  });

  it('distinguishes pending payment and activating from active', () => {
    expect(
      getOrgKiloPassRowState({
        data: summary({
          state: 'pending_payment',
          commercialState: 'pending_payment',
        }),
        isError: false,
      }).subtitle
    ).toBe('Payment pending');
    expect(
      getOrgKiloPassRowState({
        data: summary({ state: 'activating', commercialState: null }),
        isError: false,
      }).subtitle
    ).toBe('Activating');
  });

  it('distinguishes cancel-at-period-end, with the paid-through date when present', () => {
    expect(
      getOrgKiloPassRowState({
        data: summary({ state: 'cancel_at_period_end', commercialState: 'cancel_at_period_end' }),
        isError: false,
      }).subtitle
    ).toBe('Canceling · $49 · 8 paid seats');

    const paidThrough = '2027-03-01T00:00:00+00:00';
    expect(
      getOrgKiloPassRowState({
        data: summary({
          state: 'cancel_at_period_end',
          commercialState: 'cancel_at_period_end',
          agreement: agreement({ paidThrough }),
        }),
        isError: false,
      }).subtitle
    ).toBe(`Ends ${formatDate(parseTimestamp(paidThrough), i18n.language)} · $49 · 8 paid seats`);
  });

  it('surfaces blocked / failed / manual conditions ahead of the commercial state', () => {
    const cases = [
      { processingCondition: 'blocked', subtitle: 'Processing blocked' },
      { processingCondition: 'overallocated', subtitle: 'Pass assignments exceed paid seats' },
      {
        processingCondition: 'failed',
        subtitle: 'Credit processing delayed · retrying automatically',
      },
      { processingCondition: 'manual', subtitle: 'Processing needs review' },
      { processingCondition: 'suspended_for_review', subtitle: 'Payment needs attention' },
    ] as const;
    for (const { processingCondition, subtitle } of cases) {
      const row = getOrgKiloPassRowState({
        // Commercial state stays active on purpose: the condition must win.
        data: summary({ processingCondition }),
        isError: false,
      });
      expect(row.subtitle).toBe(subtitle);
      expect(row.attention).toBe(true);
      expect(row.action).toBe('manage');
    }
  });

  it('treats an ended agreement as ended and keeps it on the detail page', () => {
    const row = getOrgKiloPassRowState({
      data: summary({
        state: 'ended',
        commercialState: 'ended',
        processingCondition: null,
      }),
      isError: false,
    });
    expect(row.subtitle).toBe('Ended');
    expect(row.action).toBe('manage');
  });

  it('renders an inert busy row without a web action while the query is pending', () => {
    const row = getOrgKiloPassRowState({ data: undefined, isError: false });
    expect(row.action).toBe('none');
    expect(row.actionLabel).toBeNull();
    expect(row.accessibilityHint).toBeNull();
    expect(row.loading).toBe(true);
  });

  it('selects the retry action, not a web action, on query failure without data', () => {
    const row = getOrgKiloPassRowState({ data: undefined, isError: true });
    expect(row).toEqual({
      subtitle: 'Could not load status',
      attention: true,
      action: 'retry',
      actionLabel: 'Retry',
      accessibilityHint: 'Retries loading Kilo Pass status.',
      loading: false,
    });
  });

  it('keeps showing stale summary data when a background refetch fails', () => {
    const row = getOrgKiloPassRowState({ data: summary(), isError: true });
    expect(row.action).toBe('manage');
    expect(row.subtitle).toBe('$49 · 8 paid seats');
  });
});

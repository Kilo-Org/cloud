import { describe, test, expect, afterEach } from '@jest/globals';

import { db } from '@/lib/drizzle';
import { kilo_pass_subscriptions, kilocode_users } from '@kilocode/db/schema';
import { KiloPassCadence } from './enums';
import { KiloPassTier } from '@/lib/kilo-pass/enums';

import { insertTestUser } from '@/tests/helpers/user.helper';

import { getKiloPassStateForUser } from '@/lib/kilo-pass/state';

describe('getKiloPassStateForUser', () => {
  afterEach(async () => {
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(kilo_pass_subscriptions);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(kilocode_users);
  });

  test('prefers most recently started active subscription over pending_cancel and ended', async () => {
    const user = await insertTestUser();

    await db.insert(kilo_pass_subscriptions).values([
      {
        kilo_user_id: user.id,
        stripe_subscription_id: `test-stripe-sub-ended-${crypto.randomUUID()}`,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'canceled',
        cancel_at_period_end: false,
        started_at: '2025-01-01T00:00:00.000Z',
        ended_at: '2025-02-01T00:00:00.000Z',
        current_streak_months: 1,
        next_yearly_issue_at: null,
      },
      {
        kilo_user_id: user.id,
        stripe_subscription_id: `test-stripe-sub-pending-${crypto.randomUUID()}`,
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        cancel_at_period_end: true, // pending cancellation
        started_at: '2025-03-01T00:00:00.000Z',
        ended_at: null,
        current_streak_months: 3,
        next_yearly_issue_at: null,
      },
      {
        kilo_user_id: user.id,
        stripe_subscription_id: `test-stripe-sub-active-old-${crypto.randomUUID()}`,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Yearly,
        status: 'active',
        cancel_at_period_end: false,
        started_at: '2025-04-01T00:00:00.000Z',
        ended_at: null,
        current_streak_months: 5,
        next_yearly_issue_at: '2025-12-01T00:00:00.000Z',
      },
      {
        kilo_user_id: user.id,
        stripe_subscription_id: `test-stripe-sub-active-new-${crypto.randomUUID()}`,
        tier: KiloPassTier.Tier199,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        cancel_at_period_end: false,
        started_at: '2025-05-01T00:00:00.000Z',
        ended_at: null,
        current_streak_months: 6,
        next_yearly_issue_at: null,
      },
    ]);

    const state = await getKiloPassStateForUser(db, user.id);

    expect(state).toEqual(
      expect.objectContaining({
        tier: KiloPassTier.Tier199,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        cancelAtPeriodEnd: false,
        currentStreakMonths: 6,
        nextYearlyIssueAt: null,
        stripeSubscriptionId: expect.stringMatching(/^test-stripe-sub-active-new-/),
      })
    );
  });

  test('falls back to pending_cancel when there is no active subscription', async () => {
    const user = await insertTestUser();

    await db.insert(kilo_pass_subscriptions).values([
      {
        kilo_user_id: user.id,
        stripe_subscription_id: `test-stripe-sub-ended-${crypto.randomUUID()}`,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'canceled',
        cancel_at_period_end: false,
        started_at: '2025-01-01T00:00:00.000Z',
        ended_at: '2025-02-01T00:00:00.000Z',
        current_streak_months: 1,
        next_yearly_issue_at: null,
      },
      {
        kilo_user_id: user.id,
        stripe_subscription_id: `test-stripe-sub-pending-old-${crypto.randomUUID()}`,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        cancel_at_period_end: true, // pending cancellation
        started_at: '2025-03-01T00:00:00.000Z',
        ended_at: null,
        current_streak_months: 3,
        next_yearly_issue_at: null,
      },
      {
        kilo_user_id: user.id,
        stripe_subscription_id: `test-stripe-sub-pending-new-${crypto.randomUUID()}`,
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Yearly,
        status: 'active',
        cancel_at_period_end: true, // pending cancellation
        started_at: '2025-04-01T00:00:00.000Z',
        ended_at: null,
        current_streak_months: 4,
        next_yearly_issue_at: '2025-12-01T00:00:00.000Z',
      },
    ]);

    const state = await getKiloPassStateForUser(db, user.id);

    expect(state).toEqual(
      expect.objectContaining({
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Yearly,
        status: 'active',
        cancelAtPeriodEnd: true,
        currentStreakMonths: 4,
        nextYearlyIssueAt: '2025-12-01T00:00:00.000Z',
        stripeSubscriptionId: expect.stringMatching(/^test-stripe-sub-pending-new-/),
      })
    );
  });

  test('returns null when the user has no subscriptions', async () => {
    const user = await insertTestUser();
    const state = await getKiloPassStateForUser(db, user.id);
    expect(state).toBeNull();
  });
});

import { describe, expect, it } from '@jest/globals';
import type Stripe from 'stripe';
import {
  LIVE_KILOCLAW_MIGRATION_STATUSES,
  buildUpdatedSchedulePhases,
  getExpectedSchedulePriceIds,
  getSchedulePhasePriceIds,
} from '@/lib/kiloclaw/price-migration';

describe('KiloClaw price migration helpers', () => {
  it('includes delinquent live statuses in the migration target set', () => {
    expect(LIVE_KILOCLAW_MIGRATION_STATUSES).toEqual(['active', 'past_due', 'unpaid']);
  });

  it('maps schedule phases to the current and scheduled plan target prices', () => {
    const schedule = {
      phases: [
        {
          start_date: 1_700_000_000,
          end_date: 1_800_000_000,
          items: [{ price: { id: 'price_old_commit' } }],
        },
        {
          start_date: 1_800_000_000,
          items: [{ price: { id: 'price_old_standard' } }],
        },
      ],
    } as unknown as Pick<Stripe.SubscriptionSchedule, 'phases'>;

    expect(
      getExpectedSchedulePriceIds({
        currentPlan: 'commit',
        scheduledPlan: 'standard',
        newPriceIds: {
          commit: 'price_new_commit',
          standard: 'price_new_standard',
        },
      })
    ).toEqual(['price_new_commit', 'price_new_standard']);

    expect(getSchedulePhasePriceIds(schedule)).toEqual(['price_old_commit', 'price_old_standard']);

    expect(
      buildUpdatedSchedulePhases({
        schedule,
        currentPlan: 'commit',
        scheduledPlan: 'standard',
        newPriceIds: {
          commit: 'price_new_commit',
          standard: 'price_new_standard',
        },
      })
    ).toEqual([
      {
        items: [{ price: 'price_new_commit' }],
        start_date: 1_700_000_000,
        end_date: 1_800_000_000,
      },
      {
        items: [{ price: 'price_new_standard' }],
        start_date: 1_800_000_000,
      },
    ]);
  });
});

import { kilo_pass_subscriptions } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import type { KiloPassCadence, KiloPassTier } from '@kilocode/web-shared/lib/kilo-pass/enums';

export async function createTestSubscription(params: {
  kiloUserId: string;
  tier: KiloPassTier;
  cadence: KiloPassCadence;
  startedAt?: string | null;
  nextYearlyIssueAt?: string | null;
}): Promise<{ subscriptionId: string }> {
  const { kiloUserId, tier, cadence, startedAt, nextYearlyIssueAt } = params;
  const stripeSubscriptionId = `stripe-sub-${kiloUserId}-${Date.now()}-${Math.random()}`;

  const inserted = await db
    .insert(kilo_pass_subscriptions)
    .values({
      kilo_user_id: kiloUserId,
      provider_subscription_id: stripeSubscriptionId,
      stripe_subscription_id: stripeSubscriptionId,
      tier,
      cadence,
      status: 'active',
      started_at: startedAt ?? null,
      next_yearly_issue_at: nextYearlyIssueAt ?? null,
    })
    .returning({ subscriptionId: kilo_pass_subscriptions.id });

  const row = inserted[0];
  if (!row) throw new Error('Failed to create test kilo_pass_subscription');
  return row;
}

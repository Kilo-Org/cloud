import 'server-only';

import type Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import type { KiloClawSubscription } from '@kilocode/db';
import { kiloclaw_subscriptions } from '@kilocode/db/schema';
import type { DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';

/** Stripe statuses from which a subscription can never bill or renew again. */
export function isEndedStripeSubscriptionStatus(status: Stripe.Subscription.Status): boolean {
  return status === 'canceled' || status === 'incomplete_expired';
}

/**
 * Cancels the local row whose Stripe subscription has ended. The billing
 * lifecycle sweeps then stop the instance and start destruction grace.
 * Callers write the change log with their own actor and reason.
 */
export async function cancelSubscriptionForEndedStripeSubscription(
  tx: DrizzleTransaction,
  subscriptionId: string
): Promise<{ before: KiloClawSubscription | null; after: KiloClawSubscription | null }> {
  const [before] = await tx
    .select()
    .from(kiloclaw_subscriptions)
    .where(eq(kiloclaw_subscriptions.id, subscriptionId))
    .limit(1);
  const [after] = await tx
    .update(kiloclaw_subscriptions)
    .set({
      status: 'canceled',
      cancel_at_period_end: false,
      pending_conversion: false,
      scheduled_plan: null,
      scheduled_by: null,
      stripe_schedule_id: null,
    })
    .where(eq(kiloclaw_subscriptions.id, subscriptionId))
    .returning();
  return { before: before ?? null, after: after ?? null };
}

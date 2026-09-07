import { and, desc, eq, sql } from 'drizzle-orm';
import {
  kilo_pass_store_events,
  kilo_pass_store_purchases,
  kilo_pass_subscriptions,
} from '@kilocode/db/schema';
import type { DrizzleTransaction } from '@/lib/drizzle';
import { KiloPassPaymentProvider } from './enums';

// A renewal creates a paid order. Grace, hold, pause and restore can change the
// same order's entitlement without creating another credit grant.
export async function reconcileGooglePlaySubscriptionState(
  tx: DrizzleTransaction,
  purchase: {
    providerSubscriptionId: string;
    providerTransactionId: string;
    expiresAtIso: string | null;
    subscriptionState: string;
  }
): Promise<void> {
  const expiry = Date.parse(purchase.expiresAtIso ?? '');
  if (!Number.isFinite(expiry)) throw new Error('Google Play entitlement has invalid expiry');
  const expired = expiry <= Date.now();
  const state = purchase.subscriptionState;
  let status: 'active' | 'past_due' | 'paused' | 'canceled';
  switch (state) {
    case 'SUBSCRIPTION_STATE_ACTIVE':
    case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD':
    case 'SUBSCRIPTION_STATE_CANCELED':
      status = expired ? 'canceled' : 'active';
      break;
    case 'SUBSCRIPTION_STATE_ON_HOLD':
      status = 'past_due';
      break;
    case 'SUBSCRIPTION_STATE_PAUSED':
      status = 'paused';
      break;
    case 'SUBSCRIPTION_STATE_EXPIRED':
      status = 'canceled';
      break;
    default:
      return;
  }
  const [subscription] = await tx
    .select({ id: kilo_pass_subscriptions.id })
    .from(kilo_pass_subscriptions)
    .where(
      and(
        eq(kilo_pass_subscriptions.payment_provider, KiloPassPaymentProvider.GooglePlay),
        eq(kilo_pass_subscriptions.provider_subscription_id, purchase.providerSubscriptionId)
      )
    )
    .for('update')
    .limit(1);
  if (!subscription) return;
  const latest = await tx.query.kilo_pass_store_purchases.findFirst({
    where: eq(kilo_pass_store_purchases.kilo_pass_subscription_id, subscription.id),
    orderBy: [
      desc(kilo_pass_store_purchases.purchased_at),
      desc(kilo_pass_store_purchases.created_at),
    ],
  });
  if (
    !latest ||
    (latest.purchase_token === purchase.providerSubscriptionId &&
      latest.provider_transaction_id !== purchase.providerTransactionId)
  )
    return;
  const revoked = await tx.query.kilo_pass_store_events.findFirst({
    columns: { id: true },
    where: and(
      eq(kilo_pass_store_events.payment_provider, KiloPassPaymentProvider.GooglePlay),
      eq(kilo_pass_store_events.provider_subscription_id, purchase.providerSubscriptionId),
      eq(kilo_pass_store_events.provider_transaction_id, purchase.providerTransactionId),
      sql`${kilo_pass_store_events.processed_at} IS NOT NULL`,
      sql`${kilo_pass_store_events.payload_json}->>'notificationType' = '12'`
    ),
  });
  if (revoked) return;
  await tx
    .update(kilo_pass_store_purchases)
    .set({ expires_at: new Date(expiry).toISOString() })
    .where(eq(kilo_pass_store_purchases.id, latest.id));
  await tx
    .update(kilo_pass_subscriptions)
    .set({
      status,
      cancel_at_period_end: status === 'active' && state === 'SUBSCRIPTION_STATE_CANCELED',
      ended_at: status === 'canceled' ? new Date(expiry).toISOString() : null,
    })
    .where(eq(kilo_pass_subscriptions.id, subscription.id));
}

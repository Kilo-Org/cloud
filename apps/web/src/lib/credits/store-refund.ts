import { NotificationTypeV2 } from '@apple/app-store-server-library';
import { and, eq, or, sql } from 'drizzle-orm';

import { credit_transactions, kilocode_users, kilo_pass_store_events } from '@kilocode/db/schema';
import type { db, DrizzleTransaction } from '@/lib/drizzle';
import { KiloPassPaymentProvider } from '@/lib/kilo-pass/enums';

import { storeCreditPaymentId } from './store-products';

export type StoreCreditReversalResult = {
  reversed: boolean;
  creditTransactionId: string | null;
  amountMicrodollars: number;
};

/**
 * The backend contract string for a completion of a store transaction the
 * store has already refunded. Kilo refused to grant the pack, so the client
 * must not treat the purchase as completed; the mobile error mapping matches
 * this exact message.
 */
export const STORE_PURCHASE_REFUNDED_MESSAGE =
  'This store purchase has been refunded, so Kilo cannot credit it.';

export type StoreCreditRefundEvent = {
  eventId: string;
  notificationType: string | null;
};

/**
 * The `kilo_pass_store_events` notification types that mean the store refunded
 * or revoked a purchase. Both handlers store the decoded type verbatim in
 * `payload_json`, so a processed event with one of these types is the durable
 * record that a purchase was refunded — including a refund that arrived before
 * Kilo granted anything. Stripe never delivers a store refund event.
 */
const STORE_REFUND_NOTIFICATION_TYPES: Record<KiloPassPaymentProvider, readonly string[]> = {
  [KiloPassPaymentProvider.Stripe]: [],
  [KiloPassPaymentProvider.AppStore]: [NotificationTypeV2.REFUND, NotificationTypeV2.REVOKE],
  // Play reports a one-time product refund as a voided purchase, for both a
  // full refund and a quantity-based partial refund.
  [KiloPassPaymentProvider.GooglePlay]: ['voided_purchase'],
};

/**
 * The processed refund event for a store credit pack, or null when the store
 * never refunded it.
 *
 * A store credit pack is one purchase, but Play names it by two ids: the order
 * id and the purchase token. A completion keys the grant by whichever the Play
 * API returned first, and a voided-purchase notification always carries an
 * order id, so every id the purchase is known by is matched here.
 */
export async function findProcessedStoreCreditRefundEvent(
  dbOrTx: DrizzleTransaction | typeof db,
  params: { paymentProvider: KiloPassPaymentProvider; providerTransactionIds: string[] }
): Promise<StoreCreditRefundEvent | null> {
  const notificationTypes = STORE_REFUND_NOTIFICATION_TYPES[params.paymentProvider];
  const keys = [...new Set(params.providerTransactionIds)].sort();
  if (notificationTypes.length === 0 || keys.length === 0) return null;

  const keyFilter = keys.flatMap(key => [
    eq(kilo_pass_store_events.provider_transaction_id, key),
    // Only Play keys a purchase by a token; an App Store `provider_subscription_id`
    // is the original transaction id of a subscription, never a credit pack.
    ...(params.paymentProvider === KiloPassPaymentProvider.GooglePlay
      ? [eq(kilo_pass_store_events.provider_subscription_id, key)]
      : []),
  ]);

  const events = await dbOrTx
    .select({
      eventId: kilo_pass_store_events.event_id,
      notificationType: sql<
        string | null
      >`${kilo_pass_store_events.payload_json}->>'notificationType'`,
    })
    .from(kilo_pass_store_events)
    .where(
      and(
        eq(kilo_pass_store_events.payment_provider, params.paymentProvider),
        sql`${kilo_pass_store_events.processed_at} IS NOT NULL`,
        sql`(${kilo_pass_store_events.payload_json}->>'notificationType') IN (${sql.join(
          notificationTypes.map(type => sql`${type}`),
          sql`, `
        )})`,
        keyFilter.length === 1 ? keyFilter[0] : or(...keyFilter)
      )
    )
    .limit(1);

  return events[0] ?? null;
}

/**
 * Serialize the grant of a store credit pack with the refund of the same
 * purchase, in either arrival order.
 *
 * Both the completion and the refund handlers take this transaction-scoped
 * advisory lock, keyed by the store payment id, before they read anything, so
 * the two can never interleave: a completion that runs first is clawed back by
 * the refund that follows, and a refund that runs first is visible to the
 * completion, which then refuses to grant at all. A plain read-then-write check
 * on either side would let both read "nothing happened yet" and leave the
 * credits granted. Keys are locked in sorted order so two refunds sharing one
 * purchase cannot deadlock.
 */
export async function lockStoreCreditPurchase(
  tx: DrizzleTransaction,
  params: { paymentProvider: KiloPassPaymentProvider; providerTransactionIds: string[] }
): Promise<void> {
  for (const key of [...new Set(params.providerTransactionIds)].sort()) {
    const paymentId = storeCreditPaymentId(params.paymentProvider, key);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${paymentId}, 0))`);
  }
}

/**
 * Store proportions are milliunits, as Apple's `consumptionPercentage` and
 * `revocationPercentage` are: 100000 is 100%.
 */
export const STORE_FULL_MILLIUNITS = 100_000;

function creditPackReversalDescription(provider: KiloPassPaymentProvider): string {
  return provider === KiloPassPaymentProvider.AppStore
    ? 'App Store credit pack refund clawback'
    : 'Google Play credit pack refund clawback';
}

async function findStoreCreditGrant(
  dbOrTx: DrizzleTransaction | typeof db,
  params: { paymentProvider: KiloPassPaymentProvider; providerTransactionId: string }
) {
  const grantedRows = await dbOrTx
    .select({
      kiloUserId: credit_transactions.kilo_user_id,
      amountMicrodollars: credit_transactions.amount_microdollars,
      microdollarsUsed: kilocode_users.microdollars_used,
      totalMicrodollarsAcquired: kilocode_users.total_microdollars_acquired,
    })
    .from(credit_transactions)
    .innerJoin(kilocode_users, eq(credit_transactions.kilo_user_id, kilocode_users.id))
    .where(
      eq(
        credit_transactions.stripe_payment_id,
        storeCreditPaymentId(params.paymentProvider, params.providerTransactionId)
      )
    )
    .limit(1);
  return grantedRows[0] ?? null;
}

/**
 * How much of a granted store credit pack the user has consumed, in milliunits
 * (0 untouched, 100000 fully used), or null when Kilo never granted it.
 *
 * A pack's credits are fungible with the rest of the balance, and
 * `microdollars_used` is lifetime and account-wide, so it says nothing about
 * spend from this pack. The unspent part is instead defined against the
 * balance at refund time: `unspent = min(granted, max(0, balance))` and
 * `spent = granted - unspent`, where balance is `total_microdollars_acquired -
 * microdollars_used`. A user with $100 of earlier spend who buys a $10 pack and
 * uses none of it therefore reports 0. Other credits count as spent before the
 * pack's, which favors the customer, and the unspent part never exceeds the
 * balance, so a refund prorated by it cannot claw back more than the user
 * still holds.
 */
export async function getStoreCreditConsumptionMilliunits(
  dbOrTx: DrizzleTransaction | typeof db,
  params: { paymentProvider: KiloPassPaymentProvider; providerTransactionId: string }
): Promise<number | null> {
  const granted = await findStoreCreditGrant(dbOrTx, params);
  if (!granted || granted.amountMicrodollars <= 0) return null;

  const balance = granted.totalMicrodollarsAcquired - granted.microdollarsUsed;
  const unspent = Math.min(granted.amountMicrodollars, Math.max(0, balance));
  const spent = granted.amountMicrodollars - unspent;
  return Math.min(
    STORE_FULL_MILLIUNITS,
    Math.max(0, Math.round((spent * STORE_FULL_MILLIUNITS) / granted.amountMicrodollars))
  );
}

/**
 * Reverse the refunded share of a store credit pack, exactly once.
 *
 * A credit pack is granted by `completeStoreCreditPurchase` under the
 * `store-credit:<provider>:<providerTransactionId>` payment id. The reversal is
 * `granted * refundedMilliunits / 100000` (refunded over paid), with the share
 * clamped to 0..100000 so the reversal stays within 0..granted, rounded to the
 * nearest microdollar, and is written as one negative row keyed by the
 * store transaction id. The amount depends only on the grant and the store's
 * refund share, never on the balance, and the key makes a replayed refund
 * notification a no-op, so the stored amount can never change. The store
 * refunded a purchase Kilo never granted against (no grant row) is a no-op,
 * not an error.
 */
export async function reverseStoreCreditPurchase(
  tx: DrizzleTransaction,
  params: {
    paymentProvider: KiloPassPaymentProvider;
    providerTransactionId: string;
    /** Refunded share of the amount paid; `STORE_FULL_MILLIUNITS` for a full refund. */
    refundedMilliunits: number;
  }
): Promise<StoreCreditReversalResult> {
  const granted = await findStoreCreditGrant(tx, params);
  if (!granted) {
    return { reversed: false, creditTransactionId: null, amountMicrodollars: 0 };
  }

  const refundedMilliunits = Math.min(
    STORE_FULL_MILLIUNITS,
    Math.max(0, Math.round(params.refundedMilliunits))
  );
  const reversalMicrodollars = Math.round(
    (granted.amountMicrodollars * refundedMilliunits) / STORE_FULL_MILLIUNITS
  );
  if (reversalMicrodollars <= 0) {
    return { reversed: false, creditTransactionId: null, amountMicrodollars: 0 };
  }

  const creditTransactionId = crypto.randomUUID();
  const creditCategory = `store-credit-refund:${params.paymentProvider}:${params.providerTransactionId}`;
  const insertResult = await tx
    .insert(credit_transactions)
    .values({
      id: creditTransactionId,
      kilo_user_id: granted.kiloUserId,
      amount_microdollars: -reversalMicrodollars,
      is_free: false,
      description: creditPackReversalDescription(params.paymentProvider),
      credit_category: creditCategory,
      check_category_uniqueness: true,
      original_baseline_microdollars_used: granted.microdollarsUsed,
    })
    .onConflictDoNothing();

  if ((insertResult.rowCount ?? 0) === 0) {
    // Already reversed by an earlier delivery of the same refund. Return the
    // existing reversal so the caller can record it without touching the balance.
    const existingRows = await tx
      .select({ id: credit_transactions.id })
      .from(credit_transactions)
      .where(
        and(
          eq(credit_transactions.kilo_user_id, granted.kiloUserId),
          eq(credit_transactions.credit_category, creditCategory)
        )
      )
      .limit(1);
    return {
      reversed: false,
      creditTransactionId: existingRows[0]?.id ?? null,
      amountMicrodollars: 0,
    };
  }

  await tx
    .update(kilocode_users)
    .set({
      total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} - ${reversalMicrodollars}`,
    })
    .where(eq(kilocode_users.id, granted.kiloUserId));

  return {
    reversed: true,
    creditTransactionId,
    amountMicrodollars: reversalMicrodollars,
  };
}

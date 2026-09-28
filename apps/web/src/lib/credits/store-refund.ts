import { and, eq, sql } from 'drizzle-orm';

import { credit_transactions, kilocode_users } from '@kilocode/db/schema';
import type { db, DrizzleTransaction } from '@/lib/drizzle';
import { KiloPassPaymentProvider } from '@/lib/kilo-pass/enums';

import { storeCreditPaymentId } from './store-products';

export type StoreCreditReversalResult = {
  reversed: boolean;
  creditTransactionId: string | null;
  amountMicrodollars: number;
};

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

import { and, eq, sql } from 'drizzle-orm';

import { credit_transactions, kilocode_users } from '@kilocode/db/schema';
import type { DrizzleTransaction } from '@/lib/drizzle';
import { KiloPassPaymentProvider } from '@/lib/kilo-pass/enums';

import { storeCreditPaymentId } from './store-products';

export type StoreCreditReversalResult = {
  reversed: boolean;
  creditTransactionId: string | null;
  amountMicrodollars: number;
};

function creditPackReversalDescription(provider: KiloPassPaymentProvider): string {
  return provider === KiloPassPaymentProvider.AppStore
    ? 'App Store credit pack refund clawback'
    : 'Google Play credit pack refund clawback';
}

/**
 * Reverse the credits of a store credit pack the store refunded, exactly once.
 *
 * A credit pack is granted by `completeStoreCreditPurchase` under the
 * `store-credit:<provider>:<providerTransactionId>` payment id. This finds that
 * grant and writes the matching negative row, keyed by the store transaction id
 * so a replayed refund notification can never reverse twice. The store refunded
 * a purchase Kilo never granted against (no grant row) is a no-op, not an error.
 */
export async function reverseStoreCreditPurchase(
  tx: DrizzleTransaction,
  params: { paymentProvider: KiloPassPaymentProvider; providerTransactionId: string }
): Promise<StoreCreditReversalResult> {
  const grantedRows = await tx
    .select({
      kiloUserId: credit_transactions.kilo_user_id,
      amountMicrodollars: credit_transactions.amount_microdollars,
      microdollarsUsed: kilocode_users.microdollars_used,
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

  const granted = grantedRows[0];
  if (!granted) {
    return { reversed: false, creditTransactionId: null, amountMicrodollars: 0 };
  }

  const creditTransactionId = crypto.randomUUID();
  const creditCategory = `store-credit-refund:${params.paymentProvider}:${params.providerTransactionId}`;
  const insertResult = await tx
    .insert(credit_transactions)
    .values({
      id: creditTransactionId,
      kilo_user_id: granted.kiloUserId,
      amount_microdollars: -granted.amountMicrodollars,
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
      total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} - ${granted.amountMicrodollars}`,
    })
    .where(eq(kilocode_users.id, granted.kiloUserId));

  return {
    reversed: true,
    creditTransactionId,
    amountMicrodollars: granted.amountMicrodollars,
  };
}

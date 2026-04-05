import { credit_transactions } from '@kilocode/db/schema';

import type { User } from '@kilocode/db/schema';
import { kilocode_users } from '@kilocode/db/schema';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { sql, eq } from 'drizzle-orm';
import { after } from 'next/server';
import { processFirstTopupBonus } from '@/lib/firstTopupBonus';
import { grantCreditForCategory } from '@/lib/promotionalCredits';
import { IS_IN_AUTOMATED_TEST } from '@/lib/config.server';

export type StripeConfig = { type: 'stripe'; stripe_payment_id: string };

type ProcessTopUpOptions = {
  /** If true, this is a native auto top-up (not Orb) */
  isAutoTopUp?: boolean;

  /**
   * Optional transaction handle.
   *
   * When provided, all DB writes are executed on this transaction.
   */
  dbOrTx?: DrizzleTransaction;

  /**
   * Override the credit transaction description.
   *
   * Useful for non-user-initiated credits (e.g. Kilo Pass).
   */
  creditDescription?: string;

  /**
   * Provide a precomputed credit transaction id.
   *
   * This enables downstream logic to reference the id without requiring
   * the credit_transactions insert to return it.
   */
  creditTransactionId?: string;

  /**
   * If true, skip any bonus processing (first top-up bonus, auto-top-up promo, etc).
   *
   * This is required for flows where `processTopUp()` is used as a generic
   * "create a paid credit transaction" primitive.
   */
  skipPostTopUpFreeStuff?: boolean;
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function processTopUp(
  user: User,
  amountInCents: number,
  config: StripeConfig,
  options: ProcessTopUpOptions = {}
) {
  const {
    isAutoTopUp = false,
    dbOrTx,
    creditDescription: creditDescriptionOverride,
    creditTransactionId: creditTransactionIdOverride,
    skipPostTopUpFreeStuff = false,
  } = options;

  const creditDescription =
    creditDescriptionOverride ??
    (isAutoTopUp ? `Auto top-up via ${config.type}` : `Top-up via ${config.type}`);
  const creditAmountInMicrodollars = amountInCents * 10_000;

  const dbHandle = dbOrTx ?? db;

  // Create a credit transaction in our database
  const new_credit_transaction_id = creditTransactionIdOverride ?? crypto.randomUUID();
  const creditTransactionOptions = {
    id: new_credit_transaction_id,
    kilo_user_id: user.id,
    is_free: false,
    amount_microdollars: creditAmountInMicrodollars,
    description: creditDescription,
    original_baseline_microdollars_used: user.microdollars_used,
    stripe_payment_id: config.stripe_payment_id,
  } satisfies typeof credit_transactions.$inferInsert;

  const attemptToInsert = await dbHandle
    .insert(credit_transactions)
    .values(creditTransactionOptions)
    .onConflictDoNothing();
  if (attemptToInsert.rowCount === 0) {
    //violated one of the unique constraints, i.e. this credit is already in the queue.
    return false;
  }

  await dbHandle
    .update(kilocode_users)
    .set({
      total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} + ${Math.round(creditAmountInMicrodollars)}`,
    })
    .where(eq(kilocode_users.id, user.id));

  if (skipPostTopUpFreeStuff) return true;

  // We're using `after` to ensure that the bonus processing happens after we've responded with the OK to Stripe
  // This is important because Stripe expects a response within a certain timeframe, and if we end up doing too much in
  // sync, we risk timing out, which will make Stripe retry the webhook.
  const processPostTopUpFreeStuff = async () => {
    await processFirstTopupBonus(user);
    if (isAutoTopUp) {
      await grantCreditForCategory(user, {
        credit_category: 'auto-top-up-promo-2025-12-19',
        counts_as_selfservice: false,
      });
    }

    if (!IS_IN_AUTOMATED_TEST) await delay(10000);
  };

  if (IS_IN_AUTOMATED_TEST) await processPostTopUpFreeStuff();
  else after(processPostTopUpFreeStuff);
  return true;
}

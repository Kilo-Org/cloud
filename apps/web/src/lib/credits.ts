import { credit_transactions } from '@kilocode/db/schema';

import type { User } from '@kilocode/db/schema';
import { kilocode_users } from '@kilocode/db/schema';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { sql, eq } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import Stripe from 'stripe';
import { after } from 'next/server';
import { processFirstTopupBonus } from '@/lib/firstTopupBonus';
import { grantCreditForCategory } from '@/lib/promotionalCredits';
import { IS_IN_AUTOMATED_TEST } from '@/lib/config.server';
import { sendCreditsTopUpEmail } from '@/lib/email';
import { client as stripeClient } from '@/lib/stripe-client';

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

    await sendTopUpConfirmationEmail({
      user,
      amountInCents,
      stripeChargeOrInvoiceId: config.stripe_payment_id,
      isAutoTopUp,
    });

    if (!IS_IN_AUTOMATED_TEST) await delay(10000);
  };

  if (IS_IN_AUTOMATED_TEST) await processPostTopUpFreeStuff();
  else after(processPostTopUpFreeStuff);
  return true;
}

// Idempotency: this function runs at most once per successful top-up because
// `processTopUp` is guarded by a unique constraint on
// `credit_transactions.stripe_payment_id` and only invokes its post-processing
// block on the row that actually inserted. Any later webhook retry for the
// same Stripe payment returns early with `false` before reaching here.
async function sendTopUpConfirmationEmail(params: {
  user: User;
  amountInCents: number;
  stripeChargeOrInvoiceId: string;
  isAutoTopUp: boolean;
}): Promise<void> {
  const { user, amountInCents, stripeChargeOrInvoiceId, isAutoTopUp } = params;
  try {
    const receiptUrl = await resolveStripeReceiptUrl(stripeChargeOrInvoiceId);
    await sendCreditsTopUpEmail({
      to: user.google_user_email,
      variant: isAutoTopUp ? 'auto' : 'manual',
      amountCents: amountInCents,
      creditsCents: amountInCents,
      purchaseDate: new Date(),
      receiptUrl,
    });
  } catch (error) {
    captureException(error, {
      tags: { source: 'credits_topup_email' },
      extra: { kilo_user_id: user.id, stripeChargeOrInvoiceId, isAutoTopUp },
    });
  }
}

async function resolveStripeReceiptUrl(stripeChargeOrInvoiceId: string): Promise<string | null> {
  // Skip outbound Stripe calls in automated tests — they are expensive,
  // flake-prone, and unnecessary for exercising the email path.
  if (IS_IN_AUTOMATED_TEST) return null;

  // Stripe charge IDs start with `ch_`; invoice IDs start with `in_`.
  // Payment intent IDs (`pi_`) are used for organization top-ups.
  try {
    if (stripeChargeOrInvoiceId.startsWith('ch_')) {
      const charge = await stripeClient.charges.retrieve(stripeChargeOrInvoiceId);
      return charge.receipt_url ?? null;
    }
    if (stripeChargeOrInvoiceId.startsWith('in_')) {
      const invoice = await stripeClient.invoices.retrieve(stripeChargeOrInvoiceId);
      return invoice.hosted_invoice_url ?? null;
    }
    if (stripeChargeOrInvoiceId.startsWith('pi_')) {
      const pi = await stripeClient.paymentIntents.retrieve(stripeChargeOrInvoiceId, {
        expand: ['latest_charge'],
      });
      const latestCharge = pi.latest_charge;
      if (latestCharge && typeof latestCharge !== 'string') {
        return latestCharge.receipt_url ?? null;
      }
      return null;
    }
    return null;
  } catch (error) {
    // Receipt URLs are a nice-to-have — never fail the email flow.
    if (error instanceof Stripe.errors.StripeError) return null;
    return null;
  }
}

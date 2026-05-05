import { credit_transactions, top_up_email_log } from '@kilocode/db/schema';

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
  const didInsertCreditTransaction = (attemptToInsert.rowCount ?? 0) > 0;

  if (!didInsertCreditTransaction) {
    // A prior processTopUp call already committed the credit transaction for
    // this stripe_payment_id (duplicate webhook / retry). The credit itself
    // is idempotent, but the confirmation email is not guaranteed to have
    // been sent — the original process could have exited between the credit
    // commit and `after(processPostTopUpFreeStuff)`. Attempt to recover the
    // email via the durable top_up_email_log marker. If a marker already
    // exists the insert collides and no second email is sent.
    if (!skipPostTopUpFreeStuff) {
      await recoverTopUpConfirmationEmailIfMissing({
        user,
        amountInCents,
        stripeChargeOrInvoiceId: config.stripe_payment_id,
        isAutoTopUp,
      });
    }
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

    await maybeSendTopUpConfirmationEmail({
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

// Best-effort at-most-once dedupe via an insert-before-send marker on
// `top_up_email_log.stripe_payment_id`. Every send attempt — first-attempt
// and webhook-retry recovery — first inserts a marker row with
// `onConflictDoNothing()`. A rowCount of 0 means an earlier attempt already
// claimed this payment, so we bail without sending again. If the provider
// was not configured (e.g. Mailgun env missing in preview/test), the marker
// is cleared so a future retry can re-attempt.
//
// Known gaps shared with every other insert-before-send email path in this
// codebase (`maybeSendKiloClawSubscriptionStartedEmail` below,
// `services/kiloclaw-billing/src/lifecycle.ts` ~L850, and the
// `kiloclaw_email_log`-gated sends in `apps/web/src/app/api/internal/kiloclaw/`):
//   1. A crash between the marker insert and the provider send permanently
//      suppresses the email on retry — the marker looks "already sent".
//   2. Rolling the marker back in the catch block after an ambiguous provider
//      exception can duplicate the email if the provider actually accepted it.
// Fixing either properly requires a real outbox (pending/sent/terminal state
// + provider idempotency keys) applied uniformly across all of the above
// call sites. Tracked as follow-up tech debt; intentionally NOT fixed in
// isolation here so the new email paths stay uniform with the existing ones.
async function maybeSendTopUpConfirmationEmail(params: {
  user: User;
  amountInCents: number;
  stripeChargeOrInvoiceId: string;
  isAutoTopUp: boolean;
}): Promise<void> {
  const { user, amountInCents, stripeChargeOrInvoiceId, isAutoTopUp } = params;
  try {
    const insertResult = await db
      .insert(top_up_email_log)
      .values({
        stripe_payment_id: stripeChargeOrInvoiceId,
        user_id: user.id,
      })
      .onConflictDoNothing();

    if ((insertResult.rowCount ?? 0) === 0) {
      // An earlier attempt already sent this top-up email. Don't re-send.
      return;
    }

    const receiptUrl = await resolveStripeReceiptUrl(stripeChargeOrInvoiceId);
    const sendResult = await sendCreditsTopUpEmail({
      to: user.google_user_email,
      variant: isAutoTopUp ? 'auto' : 'manual',
      amountCents: amountInCents,
      creditsCents: amountInCents,
      purchaseDate: new Date(),
      receiptUrl,
    });

    // `neverbounce_rejected` is deliberately NOT cleared: NeverBounce's verdict
    // is terminal for that address, so retrying would loop forever. Keep the
    // marker so we never try again for this payment.
    if (!sendResult.sent && sendResult.reason === 'provider_not_configured') {
      await deleteTopUpEmailLog(stripeChargeOrInvoiceId);
    }
  } catch (error) {
    captureException(error, {
      tags: { source: 'credits_topup_email' },
      extra: { kilo_user_id: user.id, stripeChargeOrInvoiceId, isAutoTopUp },
    });
    // Best-effort rollback so a retry can re-attempt — mirrors the pattern in
    // `maybeSendKiloClawSubscriptionStartedEmail`.
    try {
      await deleteTopUpEmailLog(stripeChargeOrInvoiceId);
    } catch {
      // Leave the marker in place; we prefer missing one email over duplicate sends.
    }
  }
}

// Called from the duplicate-webhook path in `processTopUp`, where the credit
// transaction is already committed but the first attempt may have exited
// before sending the email. Runs the same marker-gated send so a successful
// prior send still dedupes on the unique index.
async function recoverTopUpConfirmationEmailIfMissing(params: {
  user: User;
  amountInCents: number;
  stripeChargeOrInvoiceId: string;
  isAutoTopUp: boolean;
}): Promise<void> {
  // Reuse the same gated-send path. The marker insert with
  // onConflictDoNothing() naturally skips when the original attempt already
  // sent, and fires the email when it didn't.
  if (IS_IN_AUTOMATED_TEST) {
    await maybeSendTopUpConfirmationEmail(params);
  } else {
    after(() => maybeSendTopUpConfirmationEmail(params));
  }
}

async function deleteTopUpEmailLog(stripeChargeOrInvoiceId: string): Promise<void> {
  await db
    .delete(top_up_email_log)
    .where(eq(top_up_email_log.stripe_payment_id, stripeChargeOrInvoiceId));
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
    // Receipt URLs are a nice-to-have — never fail the email flow. Narrow
    // the silenced set to the one expected subclass and surface everything
    // else, matching the autoTopUp.ts / admin-router.ts pattern of
    // swallowing specific known-benign Stripe errors and reporting the rest.
    //
    // `StripeInvalidRequestError` is the expected outcome when the charge /
    // invoice / payment-intent was refunded or voided between payment and
    // this lookup, or when the ID is otherwise unrecognizable to Stripe.
    // Everything else — rate-limit / API 5xx / auth failure after key
    // rotation / non-Stripe programmer error — is engineer-actionable.
    if (error instanceof Stripe.errors.StripeInvalidRequestError) {
      return null;
    }
    captureException(error, {
      tags: { source: 'credits_topup_receipt_lookup' },
      extra: { stripeChargeOrInvoiceId },
    });
    return null;
  }
}

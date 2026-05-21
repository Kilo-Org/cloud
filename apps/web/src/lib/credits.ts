import { credit_transactions, transactional_email_log } from '@kilocode/db/schema';

import type { User } from '@kilocode/db/schema';
import { kilocode_users } from '@kilocode/db/schema';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { and, sql, eq } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import Stripe from 'stripe';
import { after } from 'next/server';
import { processFirstTopupBonus } from '@/lib/firstTopupBonus';
import { grantCreditForCategory } from '@/lib/promotionalCredits';
import { IS_IN_AUTOMATED_TEST } from '@/lib/config.server';
import { sendCreditsTopUpEmail } from '@/lib/email';
import { client as stripeClient } from '@/lib/stripe-client';
import { reportEvents } from '@/lib/ai-gateway/abuse-service';

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
const CREDITS_TOP_UP_CONFIRMATION_EMAIL_TYPE = 'credits_top_up_confirmation';

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

  const insertCreditTransactionAndUpdateBalance = async (tx: DrizzleTransaction) => {
    const attemptToInsert = await tx
      .insert(credit_transactions)
      .values(creditTransactionOptions)
      .onConflictDoNothing();
    const didInsertCreditTransaction = (attemptToInsert.rowCount ?? 0) > 0;

    if (!didInsertCreditTransaction) return false;

    const updateResult = await tx
      .update(kilocode_users)
      .set({
        total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} + ${Math.round(creditAmountInMicrodollars)}`,
      })
      .where(eq(kilocode_users.id, user.id));

    if ((updateResult.rowCount ?? 0) === 0) {
      throw new Error(`Failed to update user balance for top-up: kilo_user_id=${user.id}`);
    }

    return true;
  };

  const didInsertCreditTransaction = dbOrTx
    ? await insertCreditTransactionAndUpdateBalance(dbOrTx)
    : await db.transaction(insertCreditTransactionAndUpdateBalance);

  if (!didInsertCreditTransaction) {
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

  const emitCreditPurchasedEvent = () => {
    void reportEvents({
      events: [
        {
          type: 'billing.credit_purchased',
          data: {
            kilo_user_id: user.id,
            microdollars_acquired: creditAmountInMicrodollars,
          },
        },
      ],
    });
  };

  if (dbOrTx) {
    if (IS_IN_AUTOMATED_TEST) {
      emitCreditPurchasedEvent();
    } else {
      after(emitCreditPurchasedEvent);
    }
  } else {
    emitCreditPurchasedEvent();
  }

  if (skipPostTopUpFreeStuff) return true;

  // We're using `after` to ensure that the bonus processing happens after we've responded with the OK to Stripe
  // This is important because Stripe expects a response within a certain timeframe, and if we end up doing too much in
  // sync, we risk timing out, which will make Stripe retry the webhook.
  const processPostTopUpFreeStuff = async () => {
    await runPostTopUpBestEffortStep({
      source: 'credits_topup_first_bonus',
      user,
      stripeChargeOrInvoiceId: config.stripe_payment_id,
      isAutoTopUp,
      step: () => processFirstTopupBonus(user),
    });
    if (isAutoTopUp) {
      await runPostTopUpBestEffortStep({
        source: 'credits_topup_auto_topup_promo',
        user,
        stripeChargeOrInvoiceId: config.stripe_payment_id,
        isAutoTopUp,
        step: () =>
          grantCreditForCategory(user, {
            credit_category: 'auto-top-up-promo-2025-12-19',
            counts_as_selfservice: false,
          }),
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

async function runPostTopUpBestEffortStep(params: {
  source: string;
  user: User;
  stripeChargeOrInvoiceId: string;
  isAutoTopUp: boolean;
  step: () => Promise<unknown>;
}): Promise<void> {
  const { source, user, stripeChargeOrInvoiceId, isAutoTopUp, step } = params;
  try {
    await step();
  } catch (error) {
    captureException(error, {
      tags: { source },
      extra: { kilo_user_id: user.id, stripeChargeOrInvoiceId, isAutoTopUp },
    });
  }
}

/**
 * Best-effort at-most-once dedupe via an insert-before-send marker in
 * `transactional_email_log`. Every send attempt, first-attempt and
 * webhook-retry recovery, first inserts a marker row keyed by
 * (email_type, idempotency_key) with `onConflictDoNothing()`. A rowCount of 0
 * means an earlier attempt already claimed this payment, so we bail without
 * sending again. If the provider was not configured (e.g. Mailgun env missing
 * in preview/test), the marker is cleared so a future retry can re-attempt.
 *
 * Known gaps shared with the other insert-before-send email paths in this
 * codebase (`services/kiloclaw-billing/src/lifecycle.ts` ~L850 and the
 * `kiloclaw_email_log`-gated sends in `apps/web/src/app/api/internal/kiloclaw/`):
 * 1. A crash between the marker insert and the provider send permanently
 *    suppresses the email on retry; the marker looks "already sent".
 * 2. Rolling the marker back in the catch block after an ambiguous provider
 *    exception can duplicate the email if the provider actually accepted it.
 *
 * Fixing either properly requires a real outbox (pending/sent/terminal state
 * + provider idempotency keys) applied uniformly across all of the above
 * call sites. Tracked as follow-up tech debt; intentionally NOT fixed in
 * isolation here so the new email paths stay uniform with the existing ones.
 *
 * @param params User, top-up amount, Stripe payment identity, and auto-top-up flag.
 * @returns A promise that resolves after the idempotency check and best-effort send attempt.
 */
async function maybeSendTopUpConfirmationEmail(params: {
  user: User;
  amountInCents: number;
  stripeChargeOrInvoiceId: string;
  isAutoTopUp: boolean;
  purchaseDate?: Date;
}): Promise<void> {
  const { user, amountInCents, stripeChargeOrInvoiceId, isAutoTopUp, purchaseDate } = params;
  try {
    const insertResult = await db
      .insert(transactional_email_log)
      .values({
        user_id: user.id,
        email_type: CREDITS_TOP_UP_CONFIRMATION_EMAIL_TYPE,
        idempotency_key: stripeChargeOrInvoiceId,
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
      purchaseDate: purchaseDate ?? new Date(),
      receiptUrl,
    });

    // `neverbounce_rejected` is deliberately NOT cleared: NeverBounce's verdict
    // is terminal for that address, so retrying would loop forever. Keep the
    // marker so we never try again for this payment.
    if (!sendResult.sent && sendResult.reason === 'provider_not_configured') {
      await deleteTopUpEmailMarker(stripeChargeOrInvoiceId);
    }
  } catch (error) {
    captureException(error, {
      tags: { source: 'credits_topup_email' },
      extra: { kilo_user_id: user.id, stripeChargeOrInvoiceId, isAutoTopUp },
    });
    // Best-effort rollback so a retry can re-attempt.
    try {
      await deleteTopUpEmailMarker(stripeChargeOrInvoiceId);
    } catch {
      // Leave the marker in place; we prefer missing one email over duplicate sends.
    }
  }
}

/**
 * Called from the duplicate-webhook path in `processTopUp`, where the credit
 * transaction is already committed but the first attempt may have exited
 * before sending the email. Runs the same marker-gated send so a successful
 * prior send still dedupes on the unique index.
 *
 * @param params User, top-up amount, Stripe payment identity, and auto-top-up flag.
 * @returns A promise that resolves after the recovery send is performed or scheduled.
 */
async function recoverTopUpConfirmationEmailIfMissing(params: {
  user: User;
  amountInCents: number;
  stripeChargeOrInvoiceId: string;
  isAutoTopUp: boolean;
}): Promise<void> {
  const [creditTransaction] = await db
    .select({ createdAt: credit_transactions.created_at })
    .from(credit_transactions)
    .where(
      and(
        eq(credit_transactions.kilo_user_id, params.user.id),
        eq(credit_transactions.stripe_payment_id, params.stripeChargeOrInvoiceId)
      )
    )
    .limit(1);

  const purchaseDate = creditTransaction ? new Date(creditTransaction.createdAt) : undefined;
  const recoveryParams = { ...params, purchaseDate };

  if (IS_IN_AUTOMATED_TEST) {
    await maybeSendTopUpConfirmationEmail(recoveryParams);
  } else {
    after(() => maybeSendTopUpConfirmationEmail(recoveryParams));
  }
}

async function deleteTopUpEmailMarker(stripeChargeOrInvoiceId: string): Promise<void> {
  await db
    .delete(transactional_email_log)
    .where(
      and(
        eq(transactional_email_log.email_type, CREDITS_TOP_UP_CONFIRMATION_EMAIL_TYPE),
        eq(transactional_email_log.idempotency_key, stripeChargeOrInvoiceId)
      )
    );
}

export async function resolveStripeReceiptUrl(
  stripeChargeOrInvoiceId: string,
  options: { skipInAutomatedTest?: boolean } = {}
): Promise<string | null> {
  // Skip outbound Stripe calls in automated tests — they are expensive,
  // flake-prone, and unnecessary for exercising the email path.
  if (IS_IN_AUTOMATED_TEST && options.skipInAutomatedTest !== false) return null;

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

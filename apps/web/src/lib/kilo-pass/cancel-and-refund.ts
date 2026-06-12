import 'server-only';

import type Stripe from 'stripe';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  credit_transactions,
  kilo_pass_scheduled_changes,
  kilo_pass_subscriptions,
  kilocode_users,
  user_admin_notes,
} from '@kilocode/db/schema';
import type { db as defaultDb } from '@/lib/drizzle';
import { getKiloPassStateForUser } from '@/lib/kilo-pass/state';
import { releaseScheduledChangeForSubscription } from '@/lib/kilo-pass/scheduled-change-release';
import { fromMicrodollars } from '@/lib/utils';
import { KiloPassPaymentProvider } from '@/lib/kilo-pass/enums';
import { reportEvents } from '@/lib/ai-gateway/abuse-service';

type Db = typeof defaultDb;

export type CancelAndRefundKiloPassStripeClient = Pick<
  Stripe,
  'subscriptions' | 'invoices' | 'invoicePayments' | 'refunds' | 'errors' | 'subscriptionSchedules'
>;

export type CancelAndRefundKiloPassReason =
  | { kind: 'no_subscription' }
  | { kind: 'already_canceled' }
  | { kind: 'store_managed_subscription'; paymentProvider: 'apple' };

export type CancelAndRefundKiloPassResult =
  | {
      status: 'cancelled' | 'cancelled_and_refunded';
      refundedAmountCents: number | null;
      balanceResetAmountUsd: number | null;
      alreadyBlocked: boolean;
    }
  | {
      status: 'skipped';
      reason: CancelAndRefundKiloPassReason;
    };

export type CancelAndRefundKiloPassParams = {
  db: Db;
  stripe: CancelAndRefundKiloPassStripeClient;
  userId: string;
  reason: string;
  adminKiloUserId: string;
  refundLatestPayment?: boolean;
  noteSuffix?: string;
};

function isAlreadyCanceledStripeSubscriptionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalizedMessage = message.toLowerCase();
  return (
    (normalizedMessage.includes('already') && normalizedMessage.includes('cancel')) ||
    normalizedMessage.includes('has been canceled') ||
    normalizedMessage.includes('is canceled')
  );
}

/**
 * Cancels a user's Kilo Pass subscription, optionally refunds the latest Stripe
 * payment, zeroes their balance, blocks the account if not already blocked, and
 * appends an admin note.
 *
 * Each invocation runs its own DB transaction for the local mutations; the
 * Stripe-side calls happen before the transaction to minimize open transaction
 * time. Expected skip conditions (no subscription / already canceled) are
 * returned as structured results rather than thrown. Any other error (user not
 * found, Stripe failure not matching `charge_already_refunded`, DB failure) is
 * thrown so the caller can decide how to surface it.
 */
export async function cancelAndRefundKiloPassForUser({
  db,
  stripe,
  userId,
  reason,
  adminKiloUserId,
  refundLatestPayment = true,
  noteSuffix,
}: CancelAndRefundKiloPassParams): Promise<CancelAndRefundKiloPassResult> {
  const user = await db.query.kilocode_users.findFirst({
    columns: {
      id: true,
      stripe_customer_id: true,
      blocked_reason: true,
    },
    where: eq(kilocode_users.id, userId),
  });

  if (!user) {
    throw new Error(`User not found: ${userId}`);
  }

  const subscription = await getKiloPassStateForUser(db, userId);
  if (!subscription) {
    return { status: 'skipped', reason: { kind: 'no_subscription' } };
  }

  if (subscription.status === 'canceled') {
    return { status: 'skipped', reason: { kind: 'already_canceled' } };
  }

  if (subscription.paymentProvider !== KiloPassPaymentProvider.Stripe) {
    return {
      status: 'skipped',
      reason: { kind: 'store_managed_subscription', paymentProvider: 'apple' },
    };
  }

  const stripeSubscriptionId = subscription.stripeSubscriptionId;
  if (!stripeSubscriptionId) {
    return { status: 'skipped', reason: { kind: 'no_subscription' } };
  }

  const scheduledChange = await db.query.kilo_pass_scheduled_changes.findFirst({
    columns: { stripe_schedule_id: true },
    where: and(
      eq(kilo_pass_scheduled_changes.stripe_subscription_id, stripeSubscriptionId),
      isNull(kilo_pass_scheduled_changes.deleted_at)
    ),
  });

  if (scheduledChange) {
    await releaseScheduledChangeForSubscription({
      dbOrTx: db,
      stripe,
      stripeSubscriptionId,
      stripeScheduleIdIfMissingRow: scheduledChange.stripe_schedule_id,
      kiloUserIdIfMissingRow: userId,
      reason: 'cancel_subscription',
    });
  }

  try {
    await stripe.subscriptions.cancel(stripeSubscriptionId);
  } catch (error) {
    if (!isAlreadyCanceledStripeSubscriptionError(error)) {
      throw error;
    }
  }

  let refundedAmountCents: number | null = null;
  if (refundLatestPayment) {
    const paidInvoices = await stripe.invoices.list({
      subscription: stripeSubscriptionId,
      status: 'paid',
      limit: 1,
    });
    const paidInvoice = paidInvoices.data[0];
    if (paidInvoice) {
      const payments = await stripe.invoicePayments.list({
        invoice: paidInvoice.id,
        status: 'paid',
        limit: 1,
      });
      const rawPaymentIntent = payments.data[0]?.payment.payment_intent;
      const paymentIntentId =
        typeof rawPaymentIntent === 'string' ? rawPaymentIntent : rawPaymentIntent?.id;
      if (paymentIntentId) {
        try {
          const refund = await stripe.refunds.create({
            payment_intent: paymentIntentId,
          });
          refundedAmountCents = refund.amount;
        } catch (err) {
          if (
            !(err instanceof stripe.errors.StripeInvalidRequestError) ||
            err.code !== 'charge_already_refunded'
          ) {
            throw err;
          }
        }
      }
    }
  }

  const balanceResetAmountUsd = await db.transaction(async tx => {
    await tx
      .update(kilo_pass_subscriptions)
      .set({
        status: 'canceled',
        cancel_at_period_end: false,
        ended_at: new Date().toISOString(),
        current_streak_months: 0,
      })
      .where(eq(kilo_pass_subscriptions.stripe_subscription_id, stripeSubscriptionId));

    if (!user.blocked_reason) {
      await tx
        .update(kilocode_users)
        .set({
          blocked_reason: reason,
          blocked_at: new Date().toISOString(),
          blocked_by_kilo_user_id: adminKiloUserId,
        })
        .where(eq(kilocode_users.id, userId));
    }

    const freshUserRows = await tx
      .select({
        microdollars_used: kilocode_users.microdollars_used,
        total_microdollars_acquired: kilocode_users.total_microdollars_acquired,
      })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, userId))
      .for('update')
      .limit(1);
    const freshUser = freshUserRows[0];
    const currentBalanceMicrodollars = freshUser
      ? freshUser.total_microdollars_acquired - freshUser.microdollars_used
      : 0;

    let balanceReset: number | null = null;
    if (currentBalanceMicrodollars > 0 && freshUser) {
      await tx.insert(credit_transactions).values({
        kilo_user_id: userId,
        organization_id: null,
        is_free: true,
        amount_microdollars: -currentBalanceMicrodollars,
        credit_category: refundLatestPayment
          ? 'admin-cancel-refund-kilo-pass'
          : 'admin-cancel-kilo-pass-no-refund',
        description: `Balance zeroed by admin: ${reason}`,
        original_baseline_microdollars_used: freshUser.microdollars_used,
      });
      await tx
        .update(kilocode_users)
        .set({
          total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} - ${currentBalanceMicrodollars}`,
        })
        .where(eq(kilocode_users.id, userId));
      balanceReset = fromMicrodollars(currentBalanceMicrodollars);
    }

    const noteParts = [
      refundLatestPayment
        ? `Kilo Pass cancelled and refunded by admin.`
        : `Kilo Pass cancelled by admin.`,
      `Reason: ${reason}`,
      refundLatestPayment
        ? refundedAmountCents != null
          ? `Refunded: $${(refundedAmountCents / 100).toFixed(2)}`
          : 'No invoice to refund.'
        : 'Stripe refund skipped.',
      balanceReset != null
        ? `Balance reset: $${balanceReset.toFixed(2)} zeroed.`
        : 'Balance was already $0.',
      !user.blocked_reason ? 'Account blocked.' : 'Account was already blocked.',
    ];
    if (noteSuffix) {
      noteParts.push(noteSuffix);
    }
    await tx.insert(user_admin_notes).values({
      kilo_user_id: userId,
      note_content: noteParts.join(' '),
      admin_kilo_user_id: adminKiloUserId,
    });

    return balanceReset;
  });

  if (!user.blocked_reason) {
    void reportEvents({
      events: [
        {
          type: 'user.blocked',
          data: {
            kilo_user_id: userId,
            reason,
            actor_email: null,
          },
        },
      ],
    });
  }

  return {
    status: refundLatestPayment ? 'cancelled_and_refunded' : 'cancelled',
    refundedAmountCents,
    balanceResetAmountUsd,
    alreadyBlocked: !!user.blocked_reason,
  };
}

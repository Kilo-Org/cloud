import 'server-only';

import {
  kilocode_users,
  kilo_pass_subscriptions,
  payment_methods,
  transactional_email_log,
} from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { and, eq, inArray, isNotNull, isNull, ne, notInArray } from 'drizzle-orm';
import type Stripe from 'stripe';
import { captureException } from '@sentry/nextjs';
import { sendKiloPassDuplicateCardCanceledEmail } from '@/lib/email';

const KILO_PASS_DUPLICATE_CARD_EMAIL_TYPE = 'kilo_pass_duplicate_card_canceled';

export type ActiveKiloPassByFingerprint = {
  kiloUserId: string;
  subscriptionId: string;
  stripeSubscriptionId: string | null;
};

export async function findActiveKiloPassByCardFingerprint(
  fingerprint: string | null | undefined,
  excludingUserId: string
): Promise<ActiveKiloPassByFingerprint | null> {
  if (!fingerprint) return null;

  const otherPaymentMethods = await db
    .select({
      userId: payment_methods.user_id,
    })
    .from(payment_methods)
    .where(
      and(
        eq(payment_methods.stripe_fingerprint, fingerprint),
        ne(payment_methods.user_id, excludingUserId)
      )
    )
    .limit(10);

  const otherUserIds = [...new Set(otherPaymentMethods.map(pm => pm.userId))];
  if (otherUserIds.length === 0) return null;

  const activeSub = await db
    .select({
      kiloUserId: kilo_pass_subscriptions.kilo_user_id,
      id: kilo_pass_subscriptions.id,
      stripeSubscriptionId: kilo_pass_subscriptions.stripe_subscription_id,
    })
    .from(kilo_pass_subscriptions)
    .where(
      and(
        inArray(kilo_pass_subscriptions.kilo_user_id, otherUserIds),
        isNull(kilo_pass_subscriptions.ended_at),
        notInArray(kilo_pass_subscriptions.status, ['canceled', 'unpaid', 'incomplete_expired'])
      )
    )
    .limit(1);

  if (activeSub.length === 0) return null;

  return {
    kiloUserId: activeSub[0].kiloUserId,
    subscriptionId: activeSub[0].id,
    stripeSubscriptionId: activeSub[0].stripeSubscriptionId,
  };
}

type InvoiceWithPaymentIntent = Stripe.Invoice & {
  payment_intent?: Stripe.PaymentIntent | string | null;
};

export type DuplicateCardGateResult =
  | { blocked: false }
  | {
      blocked: true;
      otherKiloUserId: string;
      otherSubscriptionId: string;
      otherStripeSubscriptionId: string | null;
      fingerprint: string;
      stripeInvoiceId: string;
    };

async function resolveCardFingerprint(params: {
  invoice: InvoiceWithPaymentIntent;
  stripe: Stripe;
  kiloUserId: string;
}): Promise<string | null> {
  const { invoice, stripe, kiloUserId } = params;

  const paymentIntentUnion = invoice.payment_intent;
  let paymentMethodId: string | null = null;

  if (typeof paymentIntentUnion === 'string') {
    try {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentUnion);
      const pmUnion = pi.payment_method;
      paymentMethodId = typeof pmUnion === 'string' ? pmUnion : (pmUnion?.id ?? null);
    } catch {
      paymentMethodId = null;
    }
  } else if (paymentIntentUnion && typeof paymentIntentUnion === 'object') {
    const pmUnion = paymentIntentUnion.payment_method;
    paymentMethodId = typeof pmUnion === 'string' ? pmUnion : (pmUnion?.id ?? null);
  }

  if (paymentMethodId) {
    const localPm = await db.query.payment_methods.findFirst({
      columns: { stripe_fingerprint: true },
      where: and(
        eq(payment_methods.stripe_id, paymentMethodId),
        eq(payment_methods.user_id, kiloUserId)
      ),
    });
    if (localPm?.stripe_fingerprint) {
      return localPm.stripe_fingerprint;
    }

    try {
      const stripePm = await stripe.paymentMethods.retrieve(paymentMethodId);
      return stripePm.card?.fingerprint ?? null;
    } catch {
      return null;
    }
  }

  const customerPms = await db.query.payment_methods.findMany({
    columns: { stripe_fingerprint: true },
    where: and(
      eq(payment_methods.user_id, kiloUserId),
      isNotNull(payment_methods.stripe_fingerprint)
    ),
    limit: 1,
  });
  return customerPms[0]?.stripe_fingerprint ?? null;
}

// Card fingerprint gate for Kilo Pass subscriptions. Ensures a single card
// fingerprint can be attached to at most one active (non-canceled, non-ended)
// Kilo Pass subscription across all Kilo users at any time. When a duplicate
// is detected, the new subscription is canceled, the invoice refunded, and
// the offending user's account is blocked (if not already blocked).
//
// This gate is only applied to Stripe subscriptions (invoice.paid webhook path).
// App Store and Google Play purchases are not gated here because:
// - App Store purchases bind to an appAccountToken that already enforces one
//   Apple ID per Kilo account via the completeAppStorePurchase flow.
// - Google Play purchases similarly have their own subscription model.
// Those store paths do not go through the Stripe invoice.paid handler at all,
// so the card fingerprint check is inherently skipped for them.

export async function checkDuplicateCardFingerprintGate(params: {
  invoice: Stripe.Invoice;
  stripe: Stripe;
  kiloUserId: string;
  stripeSubscriptionId: string;
  stripeInvoiceId: string;
}): Promise<DuplicateCardGateResult> {
  const { invoice, stripe, kiloUserId, stripeSubscriptionId, stripeInvoiceId } = params;

  const invoiceWithPi = invoice as InvoiceWithPaymentIntent;

  const fingerprint = await resolveCardFingerprint({
    invoice: invoiceWithPi,
    stripe,
    kiloUserId,
  });
  if (!fingerprint) {
    return { blocked: false };
  }

  const existingActiveKiloPass = await findActiveKiloPassByCardFingerprint(fingerprint, kiloUserId);
  if (!existingActiveKiloPass) {
    return { blocked: false };
  }

  // Duplicate detected — cancel the subscription and refund.
  try {
    await stripe.subscriptions.cancel(stripeSubscriptionId, {
      invoice_now: false,
      prorate: false,
    });
  } catch (cancelError) {
    captureException(cancelError, {
      tags: { source: 'kilo_pass_duplicate_card_gate' },
      extra: { stripeSubscriptionId, kiloUserId },
    });
  }

  const paymentIntentUnion = invoiceWithPi.payment_intent;
  const paymentIntentId =
    typeof paymentIntentUnion === 'string' ? paymentIntentUnion : (paymentIntentUnion?.id ?? null);

  if (paymentIntentId) {
    try {
      await stripe.refunds.create({
        payment_intent: paymentIntentId,
        reason: 'duplicate',
        metadata: {
          kilo_pass_duplicate_card_gate: 'true',
          other_kilo_user_id: existingActiveKiloPass.kiloUserId,
          canceled_subscription_id: stripeSubscriptionId,
        },
      });
    } catch (refundError) {
      captureException(refundError, {
        tags: { source: 'kilo_pass_duplicate_card_gate' },
        extra: { paymentIntentId, stripeSubscriptionId, kiloUserId },
      });
    }
  }

  return {
    blocked: true,
    otherKiloUserId: existingActiveKiloPass.kiloUserId,
    otherSubscriptionId: existingActiveKiloPass.subscriptionId,
    otherStripeSubscriptionId: existingActiveKiloPass.stripeSubscriptionId,
    fingerprint,
    stripeInvoiceId,
  };
}

export async function maybeSendDuplicateCardCanceledEmail(params: {
  kiloUserId: string;
  stripeInvoiceId: string;
}): Promise<void> {
  const { kiloUserId, stripeInvoiceId } = params;

  try {
    const insertResult = await db
      .insert(transactional_email_log)
      .values({
        user_id: kiloUserId,
        email_type: KILO_PASS_DUPLICATE_CARD_EMAIL_TYPE,
        idempotency_key: stripeInvoiceId,
      })
      .onConflictDoNothing();

    if ((insertResult.rowCount ?? 0) === 0) {
      return;
    }

    const user = await db.query.kilocode_users.findFirst({
      columns: { google_user_email: true },
      where: eq(kilocode_users.id, kiloUserId),
    });

    if (!user?.google_user_email) {
      await db
        .delete(transactional_email_log)
        .where(
          and(
            eq(transactional_email_log.email_type, KILO_PASS_DUPLICATE_CARD_EMAIL_TYPE),
            eq(transactional_email_log.idempotency_key, stripeInvoiceId)
          )
        );
      return;
    }

    const sendResult = await sendKiloPassDuplicateCardCanceledEmail(user.google_user_email, {});

    if (!sendResult.sent && sendResult.reason === 'provider_not_configured') {
      await db
        .delete(transactional_email_log)
        .where(
          and(
            eq(transactional_email_log.email_type, KILO_PASS_DUPLICATE_CARD_EMAIL_TYPE),
            eq(transactional_email_log.idempotency_key, stripeInvoiceId)
          )
        );
    }
  } catch (error) {
    captureException(error, {
      tags: { source: 'kilo_pass_duplicate_card_email' },
      extra: { kiloUserId, stripeInvoiceId },
    });
    try {
      await db
        .delete(transactional_email_log)
        .where(
          and(
            eq(transactional_email_log.email_type, KILO_PASS_DUPLICATE_CARD_EMAIL_TYPE),
            eq(transactional_email_log.idempotency_key, stripeInvoiceId)
          )
        );
    } catch {
      // Leave the marker in place; prefer missing one email over duplicates.
    }
  }
}

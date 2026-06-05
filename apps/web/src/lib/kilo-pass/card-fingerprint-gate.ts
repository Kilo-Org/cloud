import 'server-only';

import {
  kilo_pass_accepted_card_purchases,
  kilo_pass_issuances,
  kilo_pass_subscriptions,
  kilocode_users,
  transactional_email_log,
} from '@kilocode/db/schema';
import type { DrizzleTransaction } from '@/lib/drizzle';
import { db } from '@/lib/drizzle';
import { KiloPassError } from '@/lib/kilo-pass/errors';
import type {
  RefundableSettlementTarget,
  SettledInvoicePaymentResolution,
} from '@/lib/kilo-pass/stripe-handlers-utils';
import { and, asc, eq, gt, isNotNull, lt, ne, or, sql } from 'drizzle-orm';
import type Stripe from 'stripe';
import { captureException } from '@sentry/nextjs';
import { sendKiloPassDuplicateCardCanceledEmail } from '@/lib/email';
import { createHash } from 'node:crypto';

const KILO_PASS_DUPLICATE_CARD_EMAIL_TYPE = 'kilo_pass_duplicate_card_canceled';
const DUPLICATE_CARD_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_PROVIDER_CLOCK_SKEW_MS = 5 * 60 * 1000;

export type DuplicateCardReplayAuthority = 'accepted' | 'fail_open' | null;

export type DuplicateCardGateResult =
  | { blocked: false; accepted: boolean }
  | {
      blocked: true;
      fingerprintDigest: string;
      matchedKiloUserId: string;
      matchedStripeSubscriptionId: string;
      matchedStripeInvoiceId: string;
      matchedPurchasedAt: string;
      refundableTarget: RefundableSettlementTarget | null;
    };

function reportAttributionConflict(params: {
  stripeInvoiceId: string;
  stripeSubscriptionId: string;
  kiloUserId: string;
  conflictingStripeInvoiceId?: string | null;
  conflictingStripeSubscriptionId?: string | null;
  conflictingKiloUserId?: string | null;
}): never {
  const error = new KiloPassError('Kilo Pass duplicate-card replay attribution conflict', {
    stripe_invoice_id: params.stripeInvoiceId,
    stripe_subscription_id: params.stripeSubscriptionId,
    kilo_user_id: params.kiloUserId,
  });
  captureException(error, {
    tags: { source: 'kilo_pass_duplicate_card_gate', stage: 'attribution_conflict' },
    extra: {
      stripeInvoiceId: params.stripeInvoiceId,
      stripeSubscriptionId: params.stripeSubscriptionId,
      kiloUserId: params.kiloUserId,
      conflictingStripeInvoiceId: params.conflictingStripeInvoiceId ?? null,
      conflictingStripeSubscriptionId: params.conflictingStripeSubscriptionId ?? null,
      conflictingKiloUserId: params.conflictingKiloUserId ?? null,
    },
  });
  throw error;
}

export async function acquireDuplicateCardSubscriptionLock(
  tx: DrizzleTransaction,
  stripeSubscriptionId: string
): Promise<void> {
  const lockKey = `kilo-pass:duplicate-card:subscription:${stripeSubscriptionId}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
}

async function acquireDuplicateCardDigestLock(
  tx: DrizzleTransaction,
  fingerprintDigest: string
): Promise<void> {
  const lockKey = `kilo-pass:duplicate-card:digest:${fingerprintDigest}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
}

export async function loadDuplicateCardReplayAuthority(params: {
  tx: DrizzleTransaction;
  stripeInvoiceId: string;
  stripeSubscriptionId: string;
  kiloUserId: string;
}): Promise<DuplicateCardReplayAuthority> {
  const acceptedRecords = await params.tx
    .select()
    .from(kilo_pass_accepted_card_purchases)
    .where(
      or(
        eq(kilo_pass_accepted_card_purchases.stripe_invoice_id, params.stripeInvoiceId),
        eq(kilo_pass_accepted_card_purchases.stripe_subscription_id, params.stripeSubscriptionId)
      )
    );

  for (const record of acceptedRecords) {
    if (
      record.stripe_invoice_id === params.stripeInvoiceId &&
      record.stripe_subscription_id === params.stripeSubscriptionId &&
      record.kilo_user_id === params.kiloUserId
    ) {
      return 'accepted';
    }

    reportAttributionConflict({
      ...params,
      conflictingStripeInvoiceId: record.stripe_invoice_id,
      conflictingStripeSubscriptionId: record.stripe_subscription_id,
      conflictingKiloUserId: record.kilo_user_id,
    });
  }

  const issuanceByInvoice = await params.tx
    .select({
      stripeInvoiceId: kilo_pass_issuances.stripe_invoice_id,
      stripeSubscriptionId: kilo_pass_subscriptions.stripe_subscription_id,
      kiloUserId: kilo_pass_subscriptions.kilo_user_id,
    })
    .from(kilo_pass_issuances)
    .innerJoin(
      kilo_pass_subscriptions,
      eq(kilo_pass_subscriptions.id, kilo_pass_issuances.kilo_pass_subscription_id)
    )
    .where(eq(kilo_pass_issuances.stripe_invoice_id, params.stripeInvoiceId))
    .limit(1);
  const invoiceAuthority = issuanceByInvoice[0];
  if (invoiceAuthority) {
    if (
      invoiceAuthority.stripeSubscriptionId === params.stripeSubscriptionId &&
      invoiceAuthority.kiloUserId === params.kiloUserId
    ) {
      return 'fail_open';
    }

    reportAttributionConflict({
      ...params,
      conflictingStripeInvoiceId: invoiceAuthority.stripeInvoiceId,
      conflictingStripeSubscriptionId: invoiceAuthority.stripeSubscriptionId,
      conflictingKiloUserId: invoiceAuthority.kiloUserId,
    });
  }

  const recordedSubscriptionInvoice = await params.tx
    .select({
      stripeInvoiceId: kilo_pass_issuances.stripe_invoice_id,
      stripeSubscriptionId: kilo_pass_subscriptions.stripe_subscription_id,
      kiloUserId: kilo_pass_subscriptions.kilo_user_id,
    })
    .from(kilo_pass_issuances)
    .innerJoin(
      kilo_pass_subscriptions,
      eq(kilo_pass_subscriptions.id, kilo_pass_issuances.kilo_pass_subscription_id)
    )
    .where(
      and(
        eq(kilo_pass_subscriptions.stripe_subscription_id, params.stripeSubscriptionId),
        isNotNull(kilo_pass_issuances.stripe_invoice_id)
      )
    )
    .orderBy(asc(kilo_pass_issuances.created_at))
    .limit(1);
  const recordedInvoice = recordedSubscriptionInvoice[0];
  if (recordedInvoice) {
    reportAttributionConflict({
      ...params,
      conflictingStripeInvoiceId: recordedInvoice.stripeInvoiceId,
      conflictingStripeSubscriptionId: recordedInvoice.stripeSubscriptionId,
      conflictingKiloUserId: recordedInvoice.kiloUserId,
    });
  }

  return null;
}

export function getDuplicateCardPurchaseTimestamp(invoice: Stripe.Invoice): string | null {
  const timestampSeconds = invoice.status_transitions?.paid_at ?? invoice.created ?? null;
  if (typeof timestampSeconds !== 'number' || !Number.isFinite(timestampSeconds)) return null;

  const timestampMs = timestampSeconds * 1000;
  if (!Number.isFinite(timestampMs)) return null;
  if (timestampMs > Date.now() + MAX_PROVIDER_CLOCK_SKEW_MS) {
    captureException(
      new Error('Kilo Pass invoice purchase timestamp is implausibly in the future'),
      {
        tags: { source: 'kilo_pass_duplicate_card_gate', stage: 'future_purchase_timestamp' },
        extra: { stripeInvoiceId: invoice.id, purchaseTimestampSeconds: timestampSeconds },
      }
    );
    return null;
  }

  const purchasedAt = new Date(timestampMs);
  return Number.isNaN(purchasedAt.getTime()) ? null : purchasedAt.toISOString();
}

export function digestCardFingerprint(fingerprint: string): string {
  return createHash('sha256').update(fingerprint).digest('hex');
}

async function insertAcceptedPurchase(params: {
  tx: DrizzleTransaction;
  stripeInvoiceId: string;
  stripeSubscriptionId: string;
  kiloUserId: string;
  fingerprintDigest: string;
  purchasedAt: string;
}): Promise<void> {
  const inserted = await params.tx
    .insert(kilo_pass_accepted_card_purchases)
    .values({
      stripe_invoice_id: params.stripeInvoiceId,
      stripe_subscription_id: params.stripeSubscriptionId,
      kilo_user_id: params.kiloUserId,
      fingerprint_digest: params.fingerprintDigest,
      purchased_at: params.purchasedAt,
    })
    .onConflictDoNothing()
    .returning({ stripeInvoiceId: kilo_pass_accepted_card_purchases.stripe_invoice_id });
  if (inserted.length > 0) return;

  const conflicts = await params.tx
    .select()
    .from(kilo_pass_accepted_card_purchases)
    .where(
      or(
        eq(kilo_pass_accepted_card_purchases.stripe_invoice_id, params.stripeInvoiceId),
        eq(kilo_pass_accepted_card_purchases.stripe_subscription_id, params.stripeSubscriptionId)
      )
    );
  const exactReplay = conflicts.find(
    record =>
      record.stripe_invoice_id === params.stripeInvoiceId &&
      record.stripe_subscription_id === params.stripeSubscriptionId &&
      record.kilo_user_id === params.kiloUserId
  );
  if (exactReplay) return;

  const conflict = conflicts[0];
  reportAttributionConflict({
    ...params,
    conflictingStripeInvoiceId: conflict?.stripe_invoice_id,
    conflictingStripeSubscriptionId: conflict?.stripe_subscription_id,
    conflictingKiloUserId: conflict?.kilo_user_id,
  });
}

export async function checkDuplicateCardFingerprintGate(params: {
  tx: DrizzleTransaction;
  invoice: Stripe.Invoice;
  kiloUserId: string;
  stripeSubscriptionId: string;
  getSettledPaymentResolution: () => Promise<SettledInvoicePaymentResolution>;
}): Promise<DuplicateCardGateResult> {
  const purchasedAt = getDuplicateCardPurchaseTimestamp(params.invoice);
  if (purchasedAt === null) return { blocked: false, accepted: false };

  const settlement = await params.getSettledPaymentResolution();
  if (
    settlement.kind !== 'settled' ||
    settlement.paymentMethod.kind !== 'reusable' ||
    settlement.paymentMethod.paymentMethodType !== 'card' ||
    settlement.paymentMethod.fingerprint === null
  ) {
    return { blocked: false, accepted: false };
  }

  const fingerprintDigest = digestCardFingerprint(settlement.paymentMethod.fingerprint);
  await acquireDuplicateCardDigestLock(params.tx, fingerprintDigest);

  const windowStart = new Date(
    new Date(purchasedAt).getTime() - DUPLICATE_CARD_WINDOW_MS
  ).toISOString();
  const windowEnd = new Date(
    new Date(purchasedAt).getTime() + DUPLICATE_CARD_WINDOW_MS
  ).toISOString();
  const nearestMatches = await params.tx
    .select()
    .from(kilo_pass_accepted_card_purchases)
    .where(
      and(
        eq(kilo_pass_accepted_card_purchases.fingerprint_digest, fingerprintDigest),
        ne(kilo_pass_accepted_card_purchases.kilo_user_id, params.kiloUserId),
        gt(kilo_pass_accepted_card_purchases.purchased_at, windowStart),
        lt(kilo_pass_accepted_card_purchases.purchased_at, windowEnd)
      )
    )
    .orderBy(
      sql`ABS(EXTRACT(EPOCH FROM (${kilo_pass_accepted_card_purchases.purchased_at} - ${purchasedAt}::timestamptz)))`,
      asc(kilo_pass_accepted_card_purchases.stripe_invoice_id)
    )
    .limit(1);
  const matchedPurchase = nearestMatches[0];
  if (matchedPurchase) {
    return {
      blocked: true,
      fingerprintDigest,
      matchedKiloUserId: matchedPurchase.kilo_user_id,
      matchedStripeSubscriptionId: matchedPurchase.stripe_subscription_id,
      matchedStripeInvoiceId: matchedPurchase.stripe_invoice_id,
      matchedPurchasedAt: matchedPurchase.purchased_at,
      refundableTarget: settlement.refundableTarget,
    };
  }

  await insertAcceptedPurchase({
    tx: params.tx,
    stripeInvoiceId: params.invoice.id,
    stripeSubscriptionId: params.stripeSubscriptionId,
    kiloUserId: params.kiloUserId,
    fingerprintDigest,
    purchasedAt,
  });
  return { blocked: false, accepted: true };
}

export async function attemptDuplicateCardProviderEnforcement(params: {
  stripe: Stripe;
  stripeInvoiceId: string;
  stripeSubscriptionId: string;
  kiloUserId: string;
  gateResult: Extract<DuplicateCardGateResult, { blocked: true }>;
}): Promise<void> {
  const operationalContext = {
    stripeInvoiceId: params.stripeInvoiceId,
    stripeSubscriptionId: params.stripeSubscriptionId,
    kiloUserId: params.kiloUserId,
    fingerprintDigest: params.gateResult.fingerprintDigest,
    matchedStripeInvoiceId: params.gateResult.matchedStripeInvoiceId,
    matchedStripeSubscriptionId: params.gateResult.matchedStripeSubscriptionId,
    matchedKiloUserId: params.gateResult.matchedKiloUserId,
  };

  try {
    await params.stripe.subscriptions.cancel(
      params.stripeSubscriptionId,
      { invoice_now: false, prorate: false },
      { idempotencyKey: `kilo-pass-duplicate-card-cancel:${params.stripeInvoiceId}` }
    );
  } catch (error) {
    captureException(error, {
      tags: { source: 'kilo_pass_duplicate_card_gate', stage: 'subscription_cancel' },
      extra: operationalContext,
    });
  }

  const refundableTarget = params.gateResult.refundableTarget;
  if (refundableTarget === null) {
    captureException(
      new Error('Kilo Pass duplicate-card purchase has no refundable settlement target'),
      {
        tags: { source: 'kilo_pass_duplicate_card_gate', stage: 'missing_refund_target' },
        extra: operationalContext,
      }
    );
    return;
  }

  try {
    await params.stripe.refunds.create(
      {
        ...(refundableTarget.kind === 'payment_intent'
          ? { payment_intent: refundableTarget.id }
          : { charge: refundableTarget.id }),
        reason: 'duplicate',
        metadata: {
          kilo_pass_duplicate_card_gate: 'true',
          canceled_subscription_id: params.stripeSubscriptionId,
          source_invoice_id: params.stripeInvoiceId,
        },
      },
      { idempotencyKey: `kilo-pass-duplicate-card-refund:${params.stripeInvoiceId}` }
    );
  } catch (error) {
    captureException(error, {
      tags: { source: 'kilo_pass_duplicate_card_gate', stage: 'refund' },
      extra: {
        ...operationalContext,
        refundableTargetKind: refundableTarget.kind,
        refundableTargetId: refundableTarget.id,
      },
    });
  }
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

    if ((insertResult.rowCount ?? 0) === 0) return;

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

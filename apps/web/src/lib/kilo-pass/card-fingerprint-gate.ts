import 'server-only';

import {
  kilo_pass_audit_log,
  kilo_pass_issuances,
  kilo_pass_subscriptions,
  kilo_pass_welcome_promo_payment_fingerprint_claims,
  kilocode_users,
  transactional_email_log,
} from '@kilocode/db/schema';
import type { DrizzleTransaction } from '@/lib/drizzle';
import { db } from '@/lib/drizzle';
import { KiloPassError } from '@/lib/kilo-pass/errors';
import {
  KiloPassAuditLogAction,
  KiloPassAuditLogResult,
  KiloPassWelcomePromoEligibilityReason,
  KiloPassWelcomePromoPaymentFingerprintType,
} from '@/lib/kilo-pass/enums';
import type {
  RefundableSettlementTarget,
  SettledInvoicePaymentResolution,
  SupportedReusablePaymentMethodType,
} from '@/lib/kilo-pass/stripe-handlers-utils';
import { and, eq, isNotNull, or, sql } from 'drizzle-orm';
import type Stripe from 'stripe';
import { captureException } from '@sentry/nextjs';
import { sendKiloPassDuplicateCardCanceledEmail } from '@/lib/email';
import { createHash } from 'node:crypto';

const KILO_PASS_DUPLICATE_CARD_EMAIL_TYPE = 'kilo_pass_duplicate_card_canceled';

export type PaymentFingerprintClaimResult = {
  welcomePromoReason: KiloPassWelcomePromoEligibilityReason;
  cardClaim: {
    ownership: 'current_invoice' | 'other_invoice';
    sourceStripeInvoiceId: string;
    claimedAt: string;
    fingerprintDigest: string;
    refundableTarget: RefundableSettlementTarget | null;
  } | null;
};

export type DuplicateCardGateResult =
  | { blocked: false }
  | {
      blocked: true;
      fingerprintDigest: string | null;
      firstClaimSourceStripeInvoiceId: string | null;
      firstClaimedAt: string | null;
      matchedKiloUserId: string | null;
      matchedStripeSubscriptionId: string | null;
      refundableTarget: RefundableSettlementTarget | null;
    };

export type DuplicateCardReplayAuthority =
  | { kind: 'none' }
  | { kind: 'allowed'; issuanceId: string }
  | { kind: 'blocked'; gateResult: Extract<DuplicateCardGateResult, { blocked: true }> };

function getPaymentFingerprintType(
  type: SupportedReusablePaymentMethodType
): KiloPassWelcomePromoPaymentFingerprintType {
  switch (type) {
    case 'card':
      return KiloPassWelcomePromoPaymentFingerprintType.Card;
    case 'sepa_debit':
      return KiloPassWelcomePromoPaymentFingerprintType.SepaDebit;
    case 'us_bank_account':
      return KiloPassWelcomePromoPaymentFingerprintType.UsBankAccount;
    case 'bacs_debit':
      return KiloPassWelcomePromoPaymentFingerprintType.BacsDebit;
    case 'au_becs_debit':
      return KiloPassWelcomePromoPaymentFingerprintType.AuBecsDebit;
  }
}

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

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}

export function digestCardFingerprint(fingerprint: string): string {
  return createHash('sha256').update(fingerprint).digest('hex');
}

export async function acquireDuplicateCardSubscriptionLock(
  tx: DrizzleTransaction,
  stripeSubscriptionId: string
): Promise<void> {
  const lockKey = `kilo-pass:duplicate-card:subscription:${stripeSubscriptionId}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
}

export async function claimPaymentFingerprint(params: {
  tx: DrizzleTransaction;
  stripeInvoiceId: string;
  settlement: SettledInvoicePaymentResolution;
}): Promise<PaymentFingerprintClaimResult> {
  if (params.settlement.kind !== 'settled') {
    return {
      welcomePromoReason: KiloPassWelcomePromoEligibilityReason.SettlementUnresolved,
      cardClaim: null,
    };
  }

  const settledPaymentMethod = params.settlement.paymentMethod;
  if (settledPaymentMethod.kind === 'without_supported_fingerprint') {
    return {
      welcomePromoReason: KiloPassWelcomePromoEligibilityReason.NoSupportedFingerprint,
      cardClaim: null,
    };
  }
  if (settledPaymentMethod.fingerprint === null) {
    return {
      welcomePromoReason: KiloPassWelcomePromoEligibilityReason.MissingFingerprint,
      cardClaim: null,
    };
  }

  const paymentFingerprintType = getPaymentFingerprintType(settledPaymentMethod.paymentMethodType);
  const insertedClaims = await params.tx
    .insert(kilo_pass_welcome_promo_payment_fingerprint_claims)
    .values({
      stripe_payment_method_type: paymentFingerprintType,
      stripe_fingerprint: settledPaymentMethod.fingerprint,
      source_stripe_invoice_id: params.stripeInvoiceId,
    })
    .onConflictDoNothing()
    .returning({
      sourceStripeInvoiceId:
        kilo_pass_welcome_promo_payment_fingerprint_claims.source_stripe_invoice_id,
      claimedAt: kilo_pass_welcome_promo_payment_fingerprint_claims.claimed_at,
    });
  const insertedClaim = insertedClaims[0];
  const existingClaim = insertedClaim
    ? null
    : await params.tx.query.kilo_pass_welcome_promo_payment_fingerprint_claims.findFirst({
        columns: { source_stripe_invoice_id: true, claimed_at: true },
        where: and(
          eq(
            kilo_pass_welcome_promo_payment_fingerprint_claims.stripe_payment_method_type,
            paymentFingerprintType
          ),
          eq(
            kilo_pass_welcome_promo_payment_fingerprint_claims.stripe_fingerprint,
            settledPaymentMethod.fingerprint
          )
        ),
      });

  const sourceStripeInvoiceId =
    insertedClaim?.sourceStripeInvoiceId ?? existingClaim?.source_stripe_invoice_id;
  const claimedAt = insertedClaim?.claimedAt ?? existingClaim?.claimed_at;
  if (!sourceStripeInvoiceId || !claimedAt) {
    const conflict = new KiloPassError('Kilo Pass fingerprint claim attribution conflict', {
      stripe_invoice_id: params.stripeInvoiceId,
    });
    captureException(conflict, {
      tags: { source: 'kilo_pass_duplicate_card_gate', stage: 'fingerprint_claim_conflict' },
      extra: { stripeInvoiceId: params.stripeInvoiceId, paymentFingerprintType },
    });
    throw conflict;
  }

  const ownership =
    sourceStripeInvoiceId === params.stripeInvoiceId ? 'current_invoice' : 'other_invoice';
  return {
    welcomePromoReason:
      ownership === 'current_invoice'
        ? KiloPassWelcomePromoEligibilityReason.FirstPaymentFingerprintClaim
        : KiloPassWelcomePromoEligibilityReason.FingerprintPreviouslyClaimed,
    cardClaim:
      paymentFingerprintType === KiloPassWelcomePromoPaymentFingerprintType.Card
        ? {
            ownership,
            sourceStripeInvoiceId,
            claimedAt,
            fingerprintDigest: digestCardFingerprint(settledPaymentMethod.fingerprint),
            refundableTarget: params.settlement.refundableTarget,
          }
        : null,
  };
}

export async function loadDuplicateCardReplayAuthority(params: {
  tx: DrizzleTransaction;
  stripeInvoiceId: string;
  stripeSubscriptionId: string;
  kiloUserId: string;
}): Promise<DuplicateCardReplayAuthority> {
  const blockAudits = await params.tx
    .select({
      stripeInvoiceId: kilo_pass_audit_log.stripe_invoice_id,
      stripeSubscriptionId: kilo_pass_audit_log.stripe_subscription_id,
      kiloUserId: kilo_pass_audit_log.kilo_user_id,
      payload: kilo_pass_audit_log.payload_json,
    })
    .from(kilo_pass_audit_log)
    .where(
      and(
        eq(kilo_pass_audit_log.action, KiloPassAuditLogAction.DuplicateCardSubscriptionCanceled),
        eq(kilo_pass_audit_log.result, KiloPassAuditLogResult.Success),
        or(
          eq(kilo_pass_audit_log.stripe_invoice_id, params.stripeInvoiceId),
          eq(kilo_pass_audit_log.stripe_subscription_id, params.stripeSubscriptionId)
        )
      )
    );
  const issuanceRecords = await params.tx
    .select({
      issuanceId: kilo_pass_issuances.id,
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

  for (const record of [...blockAudits, ...issuanceRecords]) {
    if (
      record.stripeInvoiceId !== params.stripeInvoiceId ||
      record.stripeSubscriptionId !== params.stripeSubscriptionId ||
      record.kiloUserId !== params.kiloUserId
    ) {
      reportAttributionConflict({
        ...params,
        conflictingStripeInvoiceId: record.stripeInvoiceId,
        conflictingStripeSubscriptionId: record.stripeSubscriptionId,
        conflictingKiloUserId: record.kiloUserId,
      });
    }
  }

  const blockAudit = blockAudits[0];
  const blockedAuthority: DuplicateCardReplayAuthority | null = blockAudit
    ? {
        kind: 'blocked',
        gateResult: {
          blocked: true,
          fingerprintDigest: payloadString(blockAudit.payload, 'fingerprintDigest'),
          firstClaimSourceStripeInvoiceId: payloadString(
            blockAudit.payload,
            'firstClaimSourceStripeInvoiceId'
          ),
          firstClaimedAt: payloadString(blockAudit.payload, 'firstClaimedAt'),
          matchedKiloUserId: payloadString(blockAudit.payload, 'matchedKiloUserId'),
          matchedStripeSubscriptionId: payloadString(
            blockAudit.payload,
            'matchedStripeSubscriptionId'
          ),
          refundableTarget: null,
        },
      }
    : null;
  const issuanceRecord = issuanceRecords[0];
  if (issuanceRecord) {
    return blockedAuthority ?? { kind: 'allowed', issuanceId: issuanceRecord.issuanceId };
  }

  const conflictingSubscriptionIssuance = (
    await params.tx
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
      .limit(1)
  )[0];
  if (conflictingSubscriptionIssuance) {
    reportAttributionConflict({
      ...params,
      conflictingStripeInvoiceId: conflictingSubscriptionIssuance.stripeInvoiceId,
      conflictingStripeSubscriptionId: conflictingSubscriptionIssuance.stripeSubscriptionId,
      conflictingKiloUserId: conflictingSubscriptionIssuance.kiloUserId,
    });
  }

  return blockedAuthority ?? { kind: 'none' };
}

export async function checkDuplicateCardFingerprintGate(params: {
  tx: DrizzleTransaction;
  kiloUserId: string;
  claimResult: PaymentFingerprintClaimResult;
}): Promise<DuplicateCardGateResult> {
  const cardClaim = params.claimResult.cardClaim;
  if (cardClaim === null || cardClaim.ownership === 'current_invoice') return { blocked: false };

  const attributions = await params.tx
    .select({
      claimedAt: kilo_pass_welcome_promo_payment_fingerprint_claims.claimed_at,
      withinCooldown: sql<boolean>`${kilo_pass_welcome_promo_payment_fingerprint_claims.claimed_at} > transaction_timestamp() - interval '24 hours'`,
      kiloUserId: kilo_pass_subscriptions.kilo_user_id,
      stripeSubscriptionId: kilo_pass_subscriptions.stripe_subscription_id,
    })
    .from(kilo_pass_welcome_promo_payment_fingerprint_claims)
    .leftJoin(
      kilo_pass_issuances,
      eq(
        kilo_pass_issuances.stripe_invoice_id,
        kilo_pass_welcome_promo_payment_fingerprint_claims.source_stripe_invoice_id
      )
    )
    .leftJoin(
      kilo_pass_subscriptions,
      eq(kilo_pass_subscriptions.id, kilo_pass_issuances.kilo_pass_subscription_id)
    )
    .where(
      eq(
        kilo_pass_welcome_promo_payment_fingerprint_claims.source_stripe_invoice_id,
        cardClaim.sourceStripeInvoiceId
      )
    )
    .limit(1);
  const attribution = attributions[0];
  if (!attribution?.kiloUserId || !attribution.stripeSubscriptionId) {
    captureException(new Error('Kilo Pass first fingerprint claim has no user attribution'), {
      tags: { source: 'kilo_pass_duplicate_card_gate', stage: 'missing_first_claim_attribution' },
      extra: {
        firstClaimSourceStripeInvoiceId: cardClaim.sourceStripeInvoiceId,
        fingerprintDigest: cardClaim.fingerprintDigest,
      },
    });
    return { blocked: false };
  }

  if (attribution.kiloUserId === params.kiloUserId || !attribution.withinCooldown) {
    return { blocked: false };
  }

  return {
    blocked: true,
    fingerprintDigest: cardClaim.fingerprintDigest,
    firstClaimSourceStripeInvoiceId: cardClaim.sourceStripeInvoiceId,
    firstClaimedAt: attribution.claimedAt,
    matchedKiloUserId: attribution.kiloUserId,
    matchedStripeSubscriptionId: attribution.stripeSubscriptionId,
    refundableTarget: cardClaim.refundableTarget,
  };
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
    firstClaimSourceStripeInvoiceId: params.gateResult.firstClaimSourceStripeInvoiceId,
    firstClaimedAt: params.gateResult.firstClaimedAt,
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

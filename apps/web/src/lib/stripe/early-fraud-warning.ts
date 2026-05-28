import 'server-only';

import { captureException } from '@sentry/nextjs';
import {
  kilocode_users,
  organizations,
  stripe_early_fraud_warning_cases,
} from '@kilocode/db/schema';
import {
  StripeEarlyFraudWarningCaseStatus,
  StripeEarlyFraudWarningOwnerClassification,
  type StripeEarlyFraudWarningOwnerClassification as OwnerClassification,
} from '@kilocode/db/schema-types';
import { and, eq, isNull, like, not, or } from 'drizzle-orm';
import type Stripe from 'stripe';

import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { client } from '@/lib/stripe-client';

type StripeReference = string | { id: string } | null | undefined;

type EarlyFraudWarningReference = {
  id: string;
  charge: StripeReference;
  payment_intent?: StripeReference;
  created?: number;
};

type ObserveEarlyFraudWarningParams = {
  eventId: string;
  eventCreated: number;
  earlyFraudWarning: EarlyFraudWarningReference;
};

type OwnerResolution = {
  classification: OwnerClassification;
  kiloUserId: string | null;
  organizationId: string | null;
  reason: string;
};

type ReviewCaseValues = {
  eventId: string;
  earlyFraudWarningId: string;
  chargeId: string | null;
  paymentIntentId: string | null;
  customerId: string | null;
  amountMinorUnits: number | null;
  currency: string | null;
  owner: OwnerResolution;
  warningCreatedAt: string;
  failureContext?: string | null;
};

function stripeReferenceId(reference: StripeReference): string | null {
  if (typeof reference === 'string') {
    return reference || null;
  }

  return reference?.id || null;
}

async function resolveOwner(
  database: DrizzleTransaction,
  customerId: string | null
): Promise<OwnerResolution> {
  if (!customerId) {
    return {
      classification: StripeEarlyFraudWarningOwnerClassification.Unmatched,
      kiloUserId: null,
      organizationId: null,
      reason: 'Warned charge has no Stripe customer; manual review required',
    };
  }

  // Keep the case insert ordered with softDeleteUser's link scrubbing for matched user rows.
  const personalOwners = await database
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(
      and(
        eq(kilocode_users.stripe_customer_id, customerId),
        or(
          isNull(kilocode_users.blocked_reason),
          not(like(kilocode_users.blocked_reason, 'soft-deleted at %'))
        )
      )
    )
    .limit(2)
    .for('update');
  const organizationOwners = await database
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.stripe_customer_id, customerId), isNull(organizations.deleted_at)))
    .limit(2);

  if (personalOwners.length === 1 && organizationOwners.length === 0) {
    return {
      classification: StripeEarlyFraudWarningOwnerClassification.Personal,
      kiloUserId: personalOwners[0].id,
      organizationId: null,
      reason: 'Observation only: canonical personal owner matched; manual review required',
    };
  }

  if (personalOwners.length === 0 && organizationOwners.length === 1) {
    return {
      classification: StripeEarlyFraudWarningOwnerClassification.Organization,
      kiloUserId: null,
      organizationId: organizationOwners[0].id,
      reason: 'Organization-owned warning; manual review required',
    };
  }

  if (personalOwners.length === 0 && organizationOwners.length === 0) {
    return {
      classification: StripeEarlyFraudWarningOwnerClassification.Unmatched,
      kiloUserId: null,
      organizationId: null,
      reason: 'No canonical customer owner matched; manual review required',
    };
  }

  return {
    classification: StripeEarlyFraudWarningOwnerClassification.Ambiguous,
    kiloUserId: null,
    organizationId: null,
    reason: 'Canonical customer ownership is ambiguous; manual review required',
  };
}

async function persistReviewCase(
  database: typeof db | DrizzleTransaction,
  values: ReviewCaseValues
): Promise<void> {
  await database
    .insert(stripe_early_fraud_warning_cases)
    .values({
      stripe_early_fraud_warning_id: values.earlyFraudWarningId,
      stripe_event_id: values.eventId,
      stripe_charge_id: values.chargeId,
      stripe_payment_intent_id: values.paymentIntentId,
      stripe_customer_id: values.customerId,
      amount_minor_units: values.amountMinorUnits,
      currency: values.currency,
      owner_classification: values.owner.classification,
      kilo_user_id: values.owner.kiloUserId,
      organization_id: values.owner.organizationId,
      status: StripeEarlyFraudWarningCaseStatus.ReviewRequired,
      reason: values.owner.reason,
      failure_context: values.failureContext ?? null,
      warning_created_at: values.warningCreatedAt,
      review_required_at: new Date().toISOString(),
    })
    .onConflictDoNothing({
      target: [stripe_early_fraud_warning_cases.stripe_early_fraud_warning_id],
    });
}

export async function observeStripeEarlyFraudWarningCreated({
  eventId,
  eventCreated,
  earlyFraudWarning,
}: ObserveEarlyFraudWarningParams): Promise<Stripe.Charge | null> {
  const chargeId = stripeReferenceId(earlyFraudWarning.charge);
  const warningCreatedAt = new Date(
    (earlyFraudWarning.created ?? eventCreated) * 1000
  ).toISOString();
  const paymentIntentId = stripeReferenceId(earlyFraudWarning.payment_intent);

  if (!chargeId) {
    await persistReviewCase(db, {
      eventId,
      earlyFraudWarningId: earlyFraudWarning.id,
      chargeId: null,
      paymentIntentId,
      customerId: null,
      amountMinorUnits: null,
      currency: null,
      owner: {
        classification: StripeEarlyFraudWarningOwnerClassification.Unmatched,
        kiloUserId: null,
        organizationId: null,
        reason: 'Warning does not identify a charge; manual review required',
      },
      warningCreatedAt,
    });
    return null;
  }

  let charge: Stripe.Charge;
  try {
    charge = await client.charges.retrieve(chargeId);
  } catch (error) {
    captureException(error, {
      tags: { source: 'stripe_early_fraud_warning_observation' },
      extra: {
        stripe_event_id: eventId,
        stripe_early_fraud_warning_id: earlyFraudWarning.id,
        stripe_charge_id: chargeId,
      },
    });
    await persistReviewCase(db, {
      eventId,
      earlyFraudWarningId: earlyFraudWarning.id,
      chargeId,
      paymentIntentId,
      customerId: null,
      amountMinorUnits: null,
      currency: null,
      owner: {
        classification: StripeEarlyFraudWarningOwnerClassification.Unmatched,
        kiloUserId: null,
        organizationId: null,
        reason: 'Charge context retrieval failed; manual review required',
      },
      warningCreatedAt,
      failureContext: 'Stripe charge retrieval failed during warning observation',
    });
    return null;
  }

  await db.transaction(async tx => {
    const owner = await resolveOwner(tx, stripeReferenceId(charge.customer));
    await persistReviewCase(tx, {
      eventId,
      earlyFraudWarningId: earlyFraudWarning.id,
      chargeId,
      paymentIntentId: paymentIntentId ?? stripeReferenceId(charge.payment_intent),
      customerId: stripeReferenceId(charge.customer),
      amountMinorUnits: charge.amount,
      currency: charge.currency,
      owner: charge.disputed
        ? {
            ...owner,
            reason: 'Warned charge is already disputed; manual review required',
          }
        : owner,
      warningCreatedAt,
    });
  });

  return charge;
}

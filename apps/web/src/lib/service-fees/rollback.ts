import 'server-only';

import { captureException } from '@sentry/nextjs';
import Stripe from 'stripe';
import { and, asc, desc, eq, gt, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';

import {
  ServiceFeeRollbackRefundStatus,
  service_fee_rollback_refunds,
  stripe_service_fee_assessments,
  type StripeServiceFeeFlow,
} from '@kilocode/db/schema';
import type { db as defaultDb } from '@kilocode/web-shared/lib/drizzle';

import {
  SERVICE_FEE_REFUND_FEE_METADATA_KEY,
  SERVICE_FEE_REFUND_PRODUCT_METADATA_KEY,
  parseServiceFeeRefundAllocationMetadata,
} from '@/lib/service-fees/refunds';

export const SERVICE_FEE_ROLLBACK_METADATA_KEY = 'serviceFeeRollback';
export const SERVICE_FEE_ROLLBACK_MAX_BATCH_SIZE = 50;
export const SERVICE_FEE_ROLLBACK_STALE_PENDING_MS = 10 * 60 * 1000;

const LIST_LIMIT = 1_000;
const REFUND_PAGE_SIZE = 100;
const INACTIVE_REFUND_STATUSES = new Set(['failed', 'canceled']);

type Db = typeof defaultDb;

export type ServiceFeeRollbackStripeClient = {
  charges: Pick<Stripe['charges'], 'retrieve'>;
  paymentIntents: Pick<Stripe['paymentIntents'], 'retrieve'>;
  refunds: Pick<Stripe['refunds'], 'list' | 'create'>;
};

export type ServiceFeeRollbackCandidate = {
  assessmentKey: string;
  flow: StripeServiceFeeFlow;
  kiloUserId: string | null;
  organizationId: string | null;
  currency: string;
  stripeChargeId: string | null;
  stripePaymentIntentId: string | null;
  stripeInvoiceId: string | null;
  chargedFeeMinor: number;
  refundedFeeMinor: number;
  disputedFeeMinor: number;
  refundableFeeMinor: number;
  previousAttempt: number | null;
  createdAt: string;
};

export type ServiceFeeRollbackRowStatus =
  | 'refunded'
  | 'already_refunded'
  | 'skipped'
  | 'failed'
  | 'outcome_unknown'
  | 'claimed_elsewhere';

export type ServiceFeeRollbackRowResult = {
  assessmentKey: string;
  flow: StripeServiceFeeFlow;
  kiloUserId: string | null;
  organizationId: string | null;
  status: ServiceFeeRollbackRowStatus;
  amountMinor: number;
  currency: string;
  stripeChargeId: string | null;
  stripeRefundId: string | null;
  reason: string | null;
};

const refundableFeeMinor = sql<number>`(${stripe_service_fee_assessments.charged_fee_minor} - ${stripe_service_fee_assessments.refunded_fee_minor} - ${stripe_service_fee_assessments.disputed_fee_minor})`;

const candidateColumns = {
  assessmentKey: stripe_service_fee_assessments.assessment_key,
  flow: stripe_service_fee_assessments.flow,
  kiloUserId: stripe_service_fee_assessments.kilo_user_id,
  organizationId: stripe_service_fee_assessments.organization_id,
  currency: stripe_service_fee_assessments.currency,
  stripeChargeId: stripe_service_fee_assessments.stripe_charge_id,
  stripePaymentIntentId: stripe_service_fee_assessments.stripe_payment_intent_id,
  stripeInvoiceId: stripe_service_fee_assessments.stripe_invoice_id,
  chargedFeeMinor: stripe_service_fee_assessments.charged_fee_minor,
  refundedFeeMinor: stripe_service_fee_assessments.refunded_fee_minor,
  disputedFeeMinor: stripe_service_fee_assessments.disputed_fee_minor,
  refundableFeeMinor: refundableFeeMinor.mapWith(Number),
  previousAttempt: service_fee_rollback_refunds.attempt,
  createdAt: stripe_service_fee_assessments.created_at,
};

/**
 * Settled, charged fees with a positive remainder that no claim has finished
 * or is still working on. Failed claims are eligible again.
 */
function candidateWhere() {
  return and(
    eq(stripe_service_fee_assessments.outcome, 'charged'),
    isNotNull(stripe_service_fee_assessments.settled_at),
    gt(stripe_service_fee_assessments.charged_fee_minor, 0),
    gt(refundableFeeMinor, 0),
    or(
      isNull(service_fee_rollback_refunds.assessment_key),
      eq(service_fee_rollback_refunds.status, ServiceFeeRollbackRefundStatus.Failed)
    )
  );
}

export async function listServiceFeeRollbackCandidates(
  database: Db,
  limit = LIST_LIMIT
): Promise<ServiceFeeRollbackCandidate[]> {
  return database
    .select(candidateColumns)
    .from(stripe_service_fee_assessments)
    .leftJoin(
      service_fee_rollback_refunds,
      eq(service_fee_rollback_refunds.assessment_key, stripe_service_fee_assessments.assessment_key)
    )
    .where(candidateWhere())
    .orderBy(
      asc(stripe_service_fee_assessments.created_at),
      asc(stripe_service_fee_assessments.assessment_key)
    )
    .limit(limit);
}

export async function getServiceFeeRollbackOverview(database: Db) {
  const candidates = await listServiceFeeRollbackCandidates(database);

  const unsettledWithFee = await database
    .select({
      assessmentKey: stripe_service_fee_assessments.assessment_key,
      flow: stripe_service_fee_assessments.flow,
      kiloUserId: stripe_service_fee_assessments.kilo_user_id,
      organizationId: stripe_service_fee_assessments.organization_id,
      currency: stripe_service_fee_assessments.currency,
      chargedFeeMinor: stripe_service_fee_assessments.charged_fee_minor,
      stripeInvoiceId: stripe_service_fee_assessments.stripe_invoice_id,
      stripePaymentIntentId: stripe_service_fee_assessments.stripe_payment_intent_id,
      createdAt: stripe_service_fee_assessments.created_at,
    })
    .from(stripe_service_fee_assessments)
    .where(
      and(
        eq(stripe_service_fee_assessments.outcome, 'charged'),
        isNull(stripe_service_fee_assessments.settled_at),
        gt(stripe_service_fee_assessments.charged_fee_minor, 0)
      )
    )
    .orderBy(asc(stripe_service_fee_assessments.created_at))
    .limit(LIST_LIMIT);

  const claims = await database
    .select({
      assessmentKey: service_fee_rollback_refunds.assessment_key,
      status: service_fee_rollback_refunds.status,
      attempt: service_fee_rollback_refunds.attempt,
      amountMinor: service_fee_rollback_refunds.amount_minor,
      currency: service_fee_rollback_refunds.currency,
      stripeChargeId: service_fee_rollback_refunds.stripe_charge_id,
      stripeRefundId: service_fee_rollback_refunds.stripe_refund_id,
      reason: service_fee_rollback_refunds.reason,
      requestedByKiloUserId: service_fee_rollback_refunds.requested_by_kilo_user_id,
      updatedAt: service_fee_rollback_refunds.updated_at,
      flow: stripe_service_fee_assessments.flow,
      kiloUserId: stripe_service_fee_assessments.kilo_user_id,
      organizationId: stripe_service_fee_assessments.organization_id,
      assessmentRefundedFeeMinor: stripe_service_fee_assessments.refunded_fee_minor,
    })
    .from(service_fee_rollback_refunds)
    .innerJoin(
      stripe_service_fee_assessments,
      eq(stripe_service_fee_assessments.assessment_key, service_fee_rollback_refunds.assessment_key)
    )
    .orderBy(desc(service_fee_rollback_refunds.updated_at))
    .limit(LIST_LIMIT);

  const totals = await database
    .select({
      status: service_fee_rollback_refunds.status,
      count: sql<number>`count(*)`.mapWith(Number),
      amountMinor:
        sql<number>`coalesce(sum(${service_fee_rollback_refunds.amount_minor}), 0)`.mapWith(Number),
    })
    .from(service_fee_rollback_refunds)
    .groupBy(service_fee_rollback_refunds.status);

  const [remaining] = await database
    .select({
      count: sql<number>`count(*)`.mapWith(Number),
      amountMinor: sql<number>`coalesce(sum(${refundableFeeMinor}), 0)`.mapWith(Number),
    })
    .from(stripe_service_fee_assessments)
    .leftJoin(
      service_fee_rollback_refunds,
      eq(service_fee_rollback_refunds.assessment_key, stripe_service_fee_assessments.assessment_key)
    )
    .where(candidateWhere());

  const staleBefore = new Date(Date.now() - SERVICE_FEE_ROLLBACK_STALE_PENDING_MS).toISOString();

  return {
    remaining: { count: remaining?.count ?? 0, amountMinor: remaining?.amountMinor ?? 0 },
    claimTotals: totals,
    candidates,
    unsettledWithFee,
    claims: claims.map(claim => ({
      ...claim,
      updatedAt: new Date(claim.updatedAt).toISOString(),
      isStalePending:
        claim.status === ServiceFeeRollbackRefundStatus.Pending &&
        new Date(claim.updatedAt).toISOString() < staleBefore,
      // A succeeded claim whose assessment has not recorded any fee refund
      // means the charge.refunded webhook has not been applied yet.
      awaitingWebhook:
        claim.status === ServiceFeeRollbackRefundStatus.Succeeded &&
        claim.amountMinor > 0 &&
        claim.assessmentRefundedFeeMinor === 0,
    })),
  };
}

export function serviceFeeRollbackIdempotencyKey(assessmentKey: string, attempt: number): string {
  return `service-fee-rollback:${assessmentKey}:${attempt}`;
}

/**
 * Claims each candidate, re-reads the fee state from Stripe, and refunds only
 * the unrefunded fee. A row whose Stripe outcome is unknown stays pending and
 * is never retried automatically; use reconcile once it is stale.
 */
export async function executeServiceFeeRollbackBatch(params: {
  database: Db;
  stripe: ServiceFeeRollbackStripeClient;
  adminKiloUserId: string;
  limit: number;
}): Promise<ServiceFeeRollbackRowResult[]> {
  const limit = Math.min(
    Math.max(1, Math.trunc(params.limit)),
    SERVICE_FEE_ROLLBACK_MAX_BATCH_SIZE
  );
  const candidates = await listServiceFeeRollbackCandidates(params.database, limit);
  const results: ServiceFeeRollbackRowResult[] = [];
  for (const candidate of candidates) {
    results.push(await refundCandidate({ ...params, candidate }));
  }
  return results;
}

async function refundCandidate(params: {
  database: Db;
  stripe: ServiceFeeRollbackStripeClient;
  adminKiloUserId: string;
  candidate: ServiceFeeRollbackCandidate;
}): Promise<ServiceFeeRollbackRowResult> {
  const { database, stripe, candidate } = params;
  const base = {
    assessmentKey: candidate.assessmentKey,
    flow: candidate.flow,
    kiloUserId: candidate.kiloUserId,
    organizationId: candidate.organizationId,
    currency: candidate.currency,
  };

  const [claim] = await database
    .insert(service_fee_rollback_refunds)
    .values({
      assessment_key: candidate.assessmentKey,
      status: ServiceFeeRollbackRefundStatus.Pending,
      attempt: 1,
      currency: candidate.currency,
      requested_by_kilo_user_id: params.adminKiloUserId,
    })
    .onConflictDoUpdate({
      target: service_fee_rollback_refunds.assessment_key,
      set: {
        status: ServiceFeeRollbackRefundStatus.Pending,
        attempt: sql`${service_fee_rollback_refunds.attempt} + 1`,
        amount_minor: 0,
        stripe_refund_id: null,
        reason: null,
        requested_by_kilo_user_id: params.adminKiloUserId,
        updated_at: sql`now()`,
      },
      setWhere: eq(service_fee_rollback_refunds.status, ServiceFeeRollbackRefundStatus.Failed),
    })
    .returning({ attempt: service_fee_rollback_refunds.attempt });

  if (!claim) {
    return {
      ...base,
      status: 'claimed_elsewhere',
      amountMinor: 0,
      stripeChargeId: candidate.stripeChargeId,
      stripeRefundId: null,
      reason: 'Another run already claimed this fee',
    };
  }

  const finish = async (
    status: ServiceFeeRollbackRefundStatus,
    row: Omit<ServiceFeeRollbackRowResult, keyof typeof base> & {
      status: ServiceFeeRollbackRowStatus;
    }
  ): Promise<ServiceFeeRollbackRowResult> => {
    await database
      .update(service_fee_rollback_refunds)
      .set({
        status,
        amount_minor: row.amountMinor,
        stripe_charge_id: row.stripeChargeId,
        stripe_refund_id: row.stripeRefundId,
        reason: row.reason,
        updated_at: sql`now()`,
      })
      .where(eq(service_fee_rollback_refunds.assessment_key, candidate.assessmentKey));
    return { ...base, ...row };
  };

  let plan: RefundPlan;
  try {
    plan = await planRefund({ database, stripe, assessmentKey: candidate.assessmentKey });
  } catch (error) {
    captureException(error, {
      tags: { source: 'service_fee_rollback', stage: 'plan' },
      extra: { assessmentKey: candidate.assessmentKey },
    });
    return finish(ServiceFeeRollbackRefundStatus.Failed, {
      status: 'failed',
      amountMinor: 0,
      stripeChargeId: candidate.stripeChargeId,
      stripeRefundId: null,
      reason: errorMessage(error),
    });
  }

  if (plan.kind === 'already_refunded') {
    return finish(ServiceFeeRollbackRefundStatus.Succeeded, {
      status: 'already_refunded',
      amountMinor: plan.amountMinor,
      stripeChargeId: plan.chargeId,
      stripeRefundId: plan.refundId,
      reason: null,
    });
  }
  if (plan.kind === 'skip') {
    return finish(ServiceFeeRollbackRefundStatus.Skipped, {
      status: 'skipped',
      amountMinor: 0,
      stripeChargeId: plan.chargeId,
      stripeRefundId: null,
      reason: plan.reason,
    });
  }

  try {
    const refund = await stripe.refunds.create(
      {
        charge: plan.chargeId,
        amount: plan.amountMinor,
        reason: 'requested_by_customer',
        metadata: {
          [SERVICE_FEE_REFUND_PRODUCT_METADATA_KEY]: '0',
          [SERVICE_FEE_REFUND_FEE_METADATA_KEY]: String(plan.amountMinor),
          [SERVICE_FEE_ROLLBACK_METADATA_KEY]: candidate.assessmentKey,
        },
      },
      { idempotencyKey: serviceFeeRollbackIdempotencyKey(candidate.assessmentKey, claim.attempt) }
    );
    return finish(ServiceFeeRollbackRefundStatus.Succeeded, {
      status: 'refunded',
      amountMinor: refund.amount,
      stripeChargeId: plan.chargeId,
      stripeRefundId: refund.id,
      reason: null,
    });
  } catch (error) {
    captureException(error, {
      tags: { source: 'service_fee_rollback', stage: 'refund' },
      extra: { assessmentKey: candidate.assessmentKey, chargeId: plan.chargeId },
    });
    if (isDefiniteStripeRejection(error)) {
      return finish(ServiceFeeRollbackRefundStatus.Failed, {
        status: 'failed',
        amountMinor: 0,
        stripeChargeId: plan.chargeId,
        stripeRefundId: null,
        reason: errorMessage(error),
      });
    }
    return finish(ServiceFeeRollbackRefundStatus.Pending, {
      status: 'outcome_unknown',
      amountMinor: plan.amountMinor,
      stripeChargeId: plan.chargeId,
      stripeRefundId: null,
      reason: `Outcome unknown; reconcile before retrying: ${errorMessage(error)}`,
    });
  }
}

type RefundPlan =
  | { kind: 'refund'; chargeId: string; amountMinor: number }
  | { kind: 'already_refunded'; chargeId: string; refundId: string; amountMinor: number }
  | { kind: 'skip'; chargeId: string | null; reason: string };

/**
 * Computes the refund from fresh database and Stripe state while the claim is
 * held. The amount never exceeds the unrefunded fee or the charge's remaining
 * refundable balance.
 */
async function planRefund(params: {
  database: Db;
  stripe: ServiceFeeRollbackStripeClient;
  assessmentKey: string;
}): Promise<RefundPlan> {
  const [assessment] = await params.database
    .select({
      currency: stripe_service_fee_assessments.currency,
      chargedFeeMinor: stripe_service_fee_assessments.charged_fee_minor,
      refundedFeeMinor: stripe_service_fee_assessments.refunded_fee_minor,
      disputedFeeMinor: stripe_service_fee_assessments.disputed_fee_minor,
      stripeChargeId: stripe_service_fee_assessments.stripe_charge_id,
      stripePaymentIntentId: stripe_service_fee_assessments.stripe_payment_intent_id,
    })
    .from(stripe_service_fee_assessments)
    .where(eq(stripe_service_fee_assessments.assessment_key, params.assessmentKey))
    .limit(1);
  if (!assessment) {
    return { kind: 'skip', chargeId: null, reason: 'Assessment not found' };
  }
  if (assessment.disputedFeeMinor > 0) {
    return {
      kind: 'skip',
      chargeId: assessment.stripeChargeId,
      reason: 'Charge is disputed; the fee left through the dispute',
    };
  }

  const chargeId = await resolveChargeId(params.stripe, assessment);
  if (!chargeId) {
    return { kind: 'skip', chargeId: null, reason: 'No Stripe charge linked to this fee' };
  }

  const charge = await params.stripe.charges.retrieve(chargeId);
  if (charge.currency !== assessment.currency) {
    return { kind: 'skip', chargeId, reason: 'Charge currency does not match the fee currency' };
  }

  const refunds = await listChargeRefunds(params.stripe, chargeId);
  const counted = refunds.filter(isActiveRefund);

  const ours = counted.find(
    refund => refund.metadata?.[SERVICE_FEE_ROLLBACK_METADATA_KEY] === params.assessmentKey
  );
  if (ours) {
    return { kind: 'already_refunded', chargeId, refundId: ours.id, amountMinor: ours.amount };
  }

  let stripeFeeRefundedMinor = 0;
  for (const refund of counted) {
    const allocation = parseServiceFeeRefundAllocationMetadata(refund.metadata);
    if (!allocation) {
      return {
        kind: 'skip',
        chargeId,
        reason: 'Charge has a refund without fee allocation metadata; review manually',
      };
    }
    stripeFeeRefundedMinor += allocation.feeMinor;
  }

  const feeRemainingMinor =
    assessment.chargedFeeMinor -
    Math.max(stripeFeeRefundedMinor, assessment.refundedFeeMinor) -
    assessment.disputedFeeMinor;
  const amountMinor = Math.min(feeRemainingMinor, charge.amount - charge.amount_refunded);
  if (amountMinor <= 0) {
    return { kind: 'skip', chargeId, reason: 'Nothing left to refund' };
  }
  return { kind: 'refund', chargeId, amountMinor };
}

async function resolveChargeId(
  stripe: ServiceFeeRollbackStripeClient,
  assessment: { stripeChargeId: string | null; stripePaymentIntentId: string | null }
): Promise<string | null> {
  if (assessment.stripeChargeId) return assessment.stripeChargeId;
  if (!assessment.stripePaymentIntentId) return null;
  const paymentIntent = await stripe.paymentIntents.retrieve(assessment.stripePaymentIntentId);
  const latestCharge = paymentIntent.latest_charge;
  if (typeof latestCharge === 'string') return latestCharge;
  return latestCharge?.id ?? null;
}

async function listChargeRefunds(
  stripe: ServiceFeeRollbackStripeClient,
  chargeId: string
): Promise<Stripe.Refund[]> {
  const refunds: Stripe.Refund[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.refunds.list({
      charge: chargeId,
      limit: REFUND_PAGE_SIZE,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    refunds.push(...page.data);
    if (!page.has_more) return refunds;
    const cursor = page.data.at(-1)?.id;
    if (!cursor) throw new Error('Stripe refund page is marked has_more without a cursor');
    startingAfter = cursor;
  }
}

/**
 * Resolves claims left pending after an unknown Stripe outcome. Only claims
 * untouched for the stale window are considered, so in-flight runs are left
 * alone. A matching rollback refund marks the claim succeeded; otherwise it
 * becomes failed and is eligible for the next batch.
 */
export async function reconcileStaleServiceFeeRollbackClaims(params: {
  database: Db;
  stripe: ServiceFeeRollbackStripeClient;
  now?: Date;
}): Promise<
  {
    assessmentKey: string;
    status: 'succeeded' | 'failed' | 'error';
    stripeRefundId: string | null;
    reason: string | null;
  }[]
> {
  const staleBefore = new Date(
    (params.now ?? new Date()).getTime() - SERVICE_FEE_ROLLBACK_STALE_PENDING_MS
  ).toISOString();
  const stale = await params.database
    .select({
      assessmentKey: service_fee_rollback_refunds.assessment_key,
      stripeChargeId: service_fee_rollback_refunds.stripe_charge_id,
      assessmentChargeId: stripe_service_fee_assessments.stripe_charge_id,
      stripePaymentIntentId: stripe_service_fee_assessments.stripe_payment_intent_id,
    })
    .from(service_fee_rollback_refunds)
    .innerJoin(
      stripe_service_fee_assessments,
      eq(stripe_service_fee_assessments.assessment_key, service_fee_rollback_refunds.assessment_key)
    )
    .where(
      and(
        eq(service_fee_rollback_refunds.status, ServiceFeeRollbackRefundStatus.Pending),
        lt(service_fee_rollback_refunds.updated_at, staleBefore)
      )
    )
    .limit(SERVICE_FEE_ROLLBACK_MAX_BATCH_SIZE);

  const results = [];
  for (const row of stale) {
    try {
      const chargeId =
        row.stripeChargeId ??
        (await resolveChargeId(params.stripe, {
          stripeChargeId: row.assessmentChargeId,
          stripePaymentIntentId: row.stripePaymentIntentId,
        }));
      const refunds = chargeId ? await listChargeRefunds(params.stripe, chargeId) : [];
      const ours = refunds.find(
        refund =>
          isActiveRefund(refund) &&
          refund.metadata?.[SERVICE_FEE_ROLLBACK_METADATA_KEY] === row.assessmentKey
      );
      const next = ours
        ? {
            status: ServiceFeeRollbackRefundStatus.Succeeded,
            amount_minor: ours.amount,
            stripe_refund_id: ours.id,
            reason: null,
          }
        : {
            status: ServiceFeeRollbackRefundStatus.Failed,
            amount_minor: 0,
            stripe_refund_id: null,
            reason: 'Reconciled: no rollback refund found on the charge',
          };
      const updated = await params.database
        .update(service_fee_rollback_refunds)
        .set({ ...next, stripe_charge_id: chargeId, updated_at: sql`now()` })
        .where(
          and(
            eq(service_fee_rollback_refunds.assessment_key, row.assessmentKey),
            eq(service_fee_rollback_refunds.status, ServiceFeeRollbackRefundStatus.Pending),
            lt(service_fee_rollback_refunds.updated_at, staleBefore)
          )
        )
        .returning({ assessmentKey: service_fee_rollback_refunds.assessment_key });
      if (updated.length === 0) continue;
      results.push({
        assessmentKey: row.assessmentKey,
        status: ours ? ('succeeded' as const) : ('failed' as const),
        stripeRefundId: ours?.id ?? null,
        reason: next.reason,
      });
    } catch (error) {
      captureException(error, {
        tags: { source: 'service_fee_rollback', stage: 'reconcile' },
        extra: { assessmentKey: row.assessmentKey },
      });
      results.push({
        assessmentKey: row.assessmentKey,
        status: 'error' as const,
        stripeRefundId: null,
        reason: errorMessage(error),
      });
    }
  }
  return results;
}

/**
 * A 4xx other than 409 means Stripe rejected the request without creating a
 * refund. Connection errors, 5xx, and idempotency conflicts are ambiguous.
 */
function isDefiniteStripeRejection(error: unknown): boolean {
  if (!(error instanceof Stripe.errors.StripeError)) return false;
  const statusCode = error.statusCode;
  return (
    typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500 && statusCode !== 409
  );
}

function isActiveRefund(refund: Stripe.Refund): boolean {
  return !INACTIVE_REFUND_STATUSES.has(refund.status ?? '');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

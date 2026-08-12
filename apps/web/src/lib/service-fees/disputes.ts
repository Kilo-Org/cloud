import 'server-only';

import {
  observeServiceFeeAssessmentDispute,
  type ServiceFeeAssessmentRecord,
} from '@/lib/service-fees/assessments';
import {
  resolveServiceFeeAssessmentFromStripeRefs,
  ServiceFeeObservationNotReadyError,
  stripeReferenceId,
  type ServiceFeeRefundAssessmentStore,
  type ServiceFeeStripeReference,
} from '@/lib/service-fees/refunds';

export const SERVICE_FEE_DISPUTE_WON_STATUSES = new Set(['won']);

export type ServiceFeeDisputeAssessmentStore = ServiceFeeRefundAssessmentStore;

export type ServiceFeeDisputeObservation = {
  id: string;
  status?: string | null;
  charge?: ServiceFeeStripeReference;
  payment_intent?: ServiceFeeStripeReference;
};

export type ServiceFeeDisputeObservationStatus = 'ignored' | 'withdrawn' | 'cleared' | 'unchanged';

export type ServiceFeeDisputeObservationResult = {
  status: ServiceFeeDisputeObservationStatus;
  assessment: ServiceFeeAssessmentRecord | null;
  disputedProductMinor: number;
  disputedFeeMinor: number;
};

/**
 * Observe `charge.dispute.funds_withdrawn`. A dispute reverses the whole
 * charge, so disputed product/fee are set to the full settled/charged amounts.
 * Outcome and refund columns are not touched.
 */
export async function observeServiceFeeDisputeFundsWithdrawn(params: {
  store: ServiceFeeDisputeAssessmentStore;
  dispute: ServiceFeeDisputeObservation;
  now?: Date;
}): Promise<ServiceFeeDisputeObservationResult> {
  const assessment = await resolveDisputeAssessment(params.store, params.dispute);
  if (!assessment) {
    return ignoredDispute(null);
  }
  if (!assessment.settledAt) {
    throw new ServiceFeeObservationNotReadyError(assessment.assessmentKey);
  }

  if (
    assessment.disputedProductMinor === assessment.settledProductMinor &&
    assessment.disputedFeeMinor === assessment.chargedFeeMinor
  ) {
    return {
      status: 'unchanged',
      assessment,
      disputedProductMinor: assessment.disputedProductMinor,
      disputedFeeMinor: assessment.disputedFeeMinor,
    };
  }

  const updated = await observeServiceFeeAssessmentDispute({
    store: params.store,
    assessmentKey: assessment.assessmentKey,
    disputedProductMinor: assessment.settledProductMinor,
    disputedFeeMinor: assessment.chargedFeeMinor,
    now: params.now,
  });

  return {
    status: 'withdrawn',
    assessment: updated,
    disputedProductMinor: updated.disputedProductMinor,
    disputedFeeMinor: updated.disputedFeeMinor,
  };
}

/**
 * Observe `charge.dispute.closed`. A won outcome clears dispute columns. Lost
 * and other closed statuses leave funds-withdrawn amounts in place. Outcome
 * and refund columns are not touched.
 */
export async function observeServiceFeeDisputeClosed(params: {
  store: ServiceFeeDisputeAssessmentStore;
  dispute: ServiceFeeDisputeObservation;
  now?: Date;
}): Promise<ServiceFeeDisputeObservationResult> {
  const assessment = await resolveDisputeAssessment(params.store, params.dispute);
  if (!assessment) {
    return ignoredDispute(null);
  }
  if (!assessment.settledAt) {
    throw new ServiceFeeObservationNotReadyError(assessment.assessmentKey);
  }

  if (!SERVICE_FEE_DISPUTE_WON_STATUSES.has(params.dispute.status ?? '')) {
    return {
      status: 'unchanged',
      assessment,
      disputedProductMinor: assessment.disputedProductMinor,
      disputedFeeMinor: assessment.disputedFeeMinor,
    };
  }

  if (assessment.disputedProductMinor === 0 && assessment.disputedFeeMinor === 0) {
    return {
      status: 'unchanged',
      assessment,
      disputedProductMinor: 0,
      disputedFeeMinor: 0,
    };
  }

  const updated = await observeServiceFeeAssessmentDispute({
    store: params.store,
    assessmentKey: assessment.assessmentKey,
    disputedProductMinor: 0,
    disputedFeeMinor: 0,
    now: params.now,
  });

  return {
    status: 'cleared',
    assessment: updated,
    disputedProductMinor: updated.disputedProductMinor,
    disputedFeeMinor: updated.disputedFeeMinor,
  };
}

async function resolveDisputeAssessment(
  store: ServiceFeeDisputeAssessmentStore,
  dispute: ServiceFeeDisputeObservation
): Promise<ServiceFeeAssessmentRecord | null> {
  return resolveServiceFeeAssessmentFromStripeRefs({
    store,
    chargeId: stripeReferenceId(dispute.charge),
    paymentIntentId: stripeReferenceId(dispute.payment_intent),
  });
}

function ignoredDispute(
  assessment: ServiceFeeAssessmentRecord | null
): ServiceFeeDisputeObservationResult {
  return {
    status: 'ignored',
    assessment,
    disputedProductMinor: assessment?.disputedProductMinor ?? 0,
    disputedFeeMinor: assessment?.disputedFeeMinor ?? 0,
  };
}

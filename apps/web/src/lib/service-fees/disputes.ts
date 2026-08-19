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
  disputedFeeMinor: number;
};

/**
 * Observe `charge.dispute.funds_withdrawn`. A dispute withdraws the whole
 * charge, so the service-fee consequence is the full charged fee. Outcome and
 * refund columns are not touched.
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

  if (assessment.disputedFeeMinor === assessment.chargedFeeMinor) {
    return {
      status: 'unchanged',
      assessment,
      disputedFeeMinor: assessment.disputedFeeMinor,
    };
  }

  const updated = await observeServiceFeeAssessmentDispute({
    store: params.store,
    assessmentKey: assessment.assessmentKey,
    disputedFeeMinor: assessment.chargedFeeMinor,
    now: params.now,
  });

  return {
    status: assessment.chargedFeeMinor === 0 ? 'unchanged' : 'withdrawn',
    assessment: updated,
    disputedFeeMinor: updated.disputedFeeMinor,
  };
}

/**
 * Observe `charge.dispute.closed`. A won outcome clears the fee consequence.
 * Lost and other closed statuses leave it in place. Outcome and refund columns
 * are not touched.
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
      disputedFeeMinor: assessment.disputedFeeMinor,
    };
  }

  if (assessment.disputedFeeMinor === 0) {
    return {
      status: 'unchanged',
      assessment,
      disputedFeeMinor: 0,
    };
  }

  const updated = await observeServiceFeeAssessmentDispute({
    store: params.store,
    assessmentKey: assessment.assessmentKey,
    disputedFeeMinor: 0,
    now: params.now,
  });

  return {
    status: 'cleared',
    assessment: updated,
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
    disputedFeeMinor: assessment?.disputedFeeMinor ?? 0,
  };
}

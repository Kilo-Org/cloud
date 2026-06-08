import {
  KiloClawCommitRetirementQualificationSource,
  KiloClawCommitRetirementState,
  KiloClawPlan,
  KiloClawScheduledPlan,
  type KiloClawCommitRetirementQualificationSource as KiloClawCommitRetirementQualificationSourceType,
  type KiloClawCommitRetirementState as KiloClawCommitRetirementStateType,
  type KiloClawPlan as KiloClawPlanType,
  type KiloClawScheduledPlan as KiloClawScheduledPlanType,
} from './schema-types';

export const KILOCLAW_COMMIT_SALES_CUTOFF = '2026-06-06T00:00:00.000Z';
export const KILOCLAW_COMMIT_STRIPE_GUARD_LEAD_DAYS = 30;

const STRIPE_GUARD_LEAD_MS = KILOCLAW_COMMIT_STRIPE_GUARD_LEAD_DAYS * 24 * 60 * 60 * 1000;

type Timestamp = string | Date;

export type KiloClawCommitRetirementEvidence = {
  plan: KiloClawPlanType;
  scheduledPlan?: KiloClawScheduledPlanType | null;
  currentPeriodStart?: Timestamp | null;
  currentPeriodEnd?: Timestamp | null;
  retirementState?: KiloClawCommitRetirementStateType | null;
  qualifiedAt?: Timestamp | null;
  qualificationSource?: KiloClawCommitRetirementQualificationSourceType | null;
  finalEndsAt?: Timestamp | null;
  standardOptedInAt?: Timestamp | null;
};

export type KiloClawCommitTermClassification =
  | 'not_involved'
  | 'pending_final_term'
  | 'final_term'
  | 'ambiguous';

export type KiloClawCommitFinalBoundaryResult =
  | { kind: 'verified'; finalEndsAt: string }
  | { kind: 'missing' }
  | { kind: 'conflicting'; localEndsAt: string; providerEndsAt: string };

export type KiloClawCommitInvoiceAuthorization =
  | 'authorized_final_term'
  | 'pre_cutoff_recovery'
  | 'forbidden_renewal'
  | 'ambiguous';

export type KiloClawCommitUserFacingRetirementState =
  | 'not_involved'
  | 'pending_final_term'
  | 'final_term_cancels'
  | 'standard_scheduled'
  | 'completed'
  | 'manual_review';

export function maySelectKiloClawCommit(now: Timestamp): boolean {
  return isBeforeKiloClawCommitSalesCutoff(now);
}

export function isBeforeKiloClawCommitSalesCutoff(timestamp: Timestamp): boolean {
  return timestampMillis(timestamp) < timestampMillis(KILOCLAW_COMMIT_SALES_CUTOFF);
}

export function classifyKiloClawCommitTerm(
  evidence: KiloClawCommitRetirementEvidence
): KiloClawCommitTermClassification {
  if (evidence.retirementState === KiloClawCommitRetirementState.ManualReview) {
    return 'ambiguous';
  }

  if (evidence.retirementState === KiloClawCommitRetirementState.PendingFinalTerm) {
    const scheduledPlanIsConsistent =
      evidence.scheduledPlan === null ||
      evidence.scheduledPlan === undefined ||
      evidence.scheduledPlan === KiloClawScheduledPlan.Commit;
    return evidence.plan === KiloClawPlan.Standard &&
      scheduledPlanIsConsistent &&
      evidence.qualificationSource ===
        KiloClawCommitRetirementQualificationSource.SwitchRequestedBeforeCutoff &&
      hasValidPreCutoffQualification(evidence)
      ? 'pending_final_term'
      : 'ambiguous';
  }

  if (
    evidence.retirementState === KiloClawCommitRetirementState.FinalTerm ||
    evidence.retirementState === KiloClawCommitRetirementState.StandardScheduled
  ) {
    const hasRequiredStandardConsent =
      evidence.retirementState !== KiloClawCommitRetirementState.StandardScheduled ||
      Boolean(evidence.standardOptedInAt);
    const hasQualificationEvidence = Boolean(evidence.qualifiedAt || evidence.qualificationSource);
    return evidence.plan === KiloClawPlan.Commit &&
      evidence.finalEndsAt &&
      hasRequiredStandardConsent &&
      (!hasQualificationEvidence || hasValidPreCutoffQualification(evidence))
      ? 'final_term'
      : 'ambiguous';
  }

  if (evidence.retirementState === KiloClawCommitRetirementState.Completed) {
    return 'not_involved';
  }

  if (evidence.retirementState) {
    return 'ambiguous';
  }

  if (evidence.plan === KiloClawPlan.Commit) {
    if (!evidence.currentPeriodStart || !evidence.currentPeriodEnd) {
      return 'ambiguous';
    }

    if (isBeforeKiloClawCommitSalesCutoff(evidence.currentPeriodStart)) {
      return 'final_term';
    }

    return hasValidPreCutoffQualification(evidence) ? 'final_term' : 'ambiguous';
  }

  if (evidence.scheduledPlan === KiloClawScheduledPlan.Commit) {
    return hasValidPreCutoffQualification(evidence) ? 'pending_final_term' : 'ambiguous';
  }

  return 'not_involved';
}

export function deriveKiloClawCommitFinalBoundary(input: {
  durableFinalEndsAt?: Timestamp | null;
  localPeriodEndsAt?: Timestamp | null;
  providerPeriodEndsAt?: Timestamp | null;
  allowLocalOnly?: boolean;
}): KiloClawCommitFinalBoundaryResult {
  const durable = optionalIso(input.durableFinalEndsAt);
  const local = optionalIso(input.localPeriodEndsAt);
  const provider = optionalIso(input.providerPeriodEndsAt);

  if (local && provider && local !== provider) {
    return { kind: 'conflicting', localEndsAt: local, providerEndsAt: provider };
  }

  if (durable) {
    if (!local && !provider) return { kind: 'missing' };

    const verifiedEvidence = local ?? provider;
    if (verifiedEvidence !== durable) {
      return {
        kind: 'conflicting',
        localEndsAt: local ?? durable,
        providerEndsAt: provider ?? durable,
      };
    }
    return { kind: 'verified', finalEndsAt: durable };
  }

  if (local && input.allowLocalOnly && !provider) {
    return { kind: 'verified', finalEndsAt: local };
  }
  if (!local || !provider) return { kind: 'missing' };
  return { kind: 'verified', finalEndsAt: local };
}

export function classifyKiloClawCommitInvoice(input: {
  invoicePeriodStart: Timestamp;
  invoicePeriodEnd: Timestamp;
  finalEndsAt?: Timestamp | null;
  qualifiedAt?: Timestamp | null;
  qualificationSource?: KiloClawCommitRetirementQualificationSourceType | null;
}): KiloClawCommitInvoiceAuthorization {
  const periodStart = timestampMillis(input.invoicePeriodStart);
  const periodEnd = timestampMillis(input.invoicePeriodEnd);
  if (periodEnd <= periodStart) return 'ambiguous';

  if (input.finalEndsAt) {
    const finalEndsAt = timestampMillis(input.finalEndsAt);
    if (periodEnd === finalEndsAt) return 'authorized_final_term';
    if (periodStart >= finalEndsAt) return 'forbidden_renewal';
    return 'ambiguous';
  }

  if (periodStart < timestampMillis(KILOCLAW_COMMIT_SALES_CUTOFF)) {
    return 'pre_cutoff_recovery';
  }

  if (
    input.qualifiedAt &&
    input.qualificationSource &&
    isBeforeKiloClawCommitSalesCutoff(input.qualifiedAt)
  ) {
    return 'authorized_final_term';
  }

  return 'forbidden_renewal';
}

export function isKiloClawCommitStripeGuardDue(input: {
  now: Timestamp;
  finalEndsAt: Timestamp;
  guardedAt?: Timestamp | null;
  standardOptedInAt?: Timestamp | null;
}): boolean {
  if (input.guardedAt || input.standardOptedInAt) return false;

  const now = timestampMillis(input.now);
  const finalEndsAt = timestampMillis(input.finalEndsAt);
  return now < finalEndsAt && now >= finalEndsAt - STRIPE_GUARD_LEAD_MS;
}

export function getKiloClawCommitUserFacingRetirementState(
  evidence: KiloClawCommitRetirementEvidence
): KiloClawCommitUserFacingRetirementState {
  if (evidence.retirementState === KiloClawCommitRetirementState.ManualReview)
    return 'manual_review';
  if (evidence.retirementState === KiloClawCommitRetirementState.Completed) return 'completed';

  const classification = classifyKiloClawCommitTerm(evidence);
  if (classification === 'ambiguous') return 'manual_review';
  if (classification === 'pending_final_term') return 'pending_final_term';
  if (classification === 'not_involved') return 'not_involved';

  return evidence.standardOptedInAt ||
    evidence.retirementState === KiloClawCommitRetirementState.StandardScheduled
    ? 'standard_scheduled'
    : 'final_term_cancels';
}

function hasValidPreCutoffQualification(evidence: KiloClawCommitRetirementEvidence): boolean {
  if (!evidence.qualifiedAt || !evidence.qualificationSource) return false;
  if (!isBeforeKiloClawCommitSalesCutoff(evidence.qualifiedAt)) return false;

  if (evidence.scheduledPlan === KiloClawScheduledPlan.Commit) {
    return (
      evidence.qualificationSource ===
      KiloClawCommitRetirementQualificationSource.SwitchRequestedBeforeCutoff
    );
  }

  return true;
}

function optionalIso(timestamp: Timestamp | null | undefined): string | null {
  return timestamp ? new Date(timestamp).toISOString() : null;
}

function timestampMillis(timestamp: Timestamp): number {
  const millis = new Date(timestamp).getTime();
  if (!Number.isFinite(millis)) throw new Error('invalid_kiloclaw_commit_retirement_timestamp');
  return millis;
}

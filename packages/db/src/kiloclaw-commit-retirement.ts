import {
  KiloClawPlan,
  KiloClawScheduledBy,
  KiloClawScheduledPlan,
  type KiloClawPlan as KiloClawPlanType,
  type KiloClawScheduledBy as KiloClawScheduledByType,
  type KiloClawScheduledPlan as KiloClawScheduledPlanType,
} from './schema-types';

export const KILOCLAW_COMMIT_SALES_CUTOFF = '2026-06-06T00:00:00.000Z';
export const KILOCLAW_COMMIT_STRIPE_GUARD_LEAD_DAYS = 30;

export const KiloClawCommitRetirementQualificationSource = {
  ActiveAtCutoff: 'active_at_cutoff',
  CheckoutConfirmedBeforeCutoff: 'checkout_confirmed_before_cutoff',
  SwitchRequestedBeforeCutoff: 'switch_requested_before_cutoff',
  RenewalDueBeforeCutoff: 'renewal_due_before_cutoff',
} as const;

export type KiloClawCommitRetirementQualificationSource =
  (typeof KiloClawCommitRetirementQualificationSource)[keyof typeof KiloClawCommitRetirementQualificationSource];

export const KiloClawCommitRetirementState = {
  PendingFinalTerm: 'pending_final_term',
  FinalTerm: 'final_term',
  StandardScheduled: 'standard_scheduled',
  Completed: 'completed',
  ManualReview: 'manual_review',
} as const;

export type KiloClawCommitRetirementState =
  (typeof KiloClawCommitRetirementState)[keyof typeof KiloClawCommitRetirementState];

const STRIPE_GUARD_LEAD_MS = KILOCLAW_COMMIT_STRIPE_GUARD_LEAD_DAYS * 24 * 60 * 60 * 1000;

type Timestamp = string | Date;

export type KiloClawCommitRetirementEvidence = {
  plan: KiloClawPlanType;
  scheduledPlan?: KiloClawScheduledPlanType | null;
  scheduledBy?: KiloClawScheduledByType | null;
  currentPeriodStart?: Timestamp | null;
  currentPeriodEnd?: Timestamp | null;
  commitEndsAt?: Timestamp | null;
  qualifiedAt?: Timestamp | null;
  qualificationSource?: KiloClawCommitRetirementQualificationSource | null;
  hasStandardConsent?: boolean;
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
  if (evidence.plan === KiloClawPlan.Commit) {
    if (!evidence.currentPeriodStart || !evidence.currentPeriodEnd || !evidence.commitEndsAt) {
      return 'ambiguous';
    }
    return optionalIso(evidence.currentPeriodEnd) === optionalIso(evidence.commitEndsAt)
      ? 'final_term'
      : 'ambiguous';
  }

  if (evidence.scheduledPlan === KiloClawScheduledPlan.Commit) {
    return hasValidPreCutoffQualification(evidence) ? 'pending_final_term' : 'ambiguous';
  }

  return 'not_involved';
}

export function deriveKiloClawCommitFinalBoundary(input: {
  commitEndsAt?: Timestamp | null;
  currentPeriodEndsAt?: Timestamp | null;
  providerPeriodEndsAt?: Timestamp | null;
  allowLocalOnly?: boolean;
}): KiloClawCommitFinalBoundaryResult {
  const commit = optionalIso(input.commitEndsAt);
  const local = optionalIso(input.currentPeriodEndsAt);
  const provider = optionalIso(input.providerPeriodEndsAt);

  if (local && provider && local !== provider) {
    return { kind: 'conflicting', localEndsAt: local, providerEndsAt: provider };
  }
  if (!commit) return { kind: 'missing' };
  if (!local && !provider) return { kind: 'missing' };

  const verifiedEvidence = local ?? provider;
  if (verifiedEvidence !== commit) {
    return {
      kind: 'conflicting',
      localEndsAt: local ?? commit,
      providerEndsAt: provider ?? commit,
    };
  }
  if (!provider && !input.allowLocalOnly) return { kind: 'missing' };
  return { kind: 'verified', finalEndsAt: commit };
}

export function classifyKiloClawCommitInvoice(input: {
  invoicePeriodStart: Timestamp;
  invoicePeriodEnd: Timestamp;
  commitEndsAt?: Timestamp | null;
  qualifiedAt?: Timestamp | null;
  qualificationSource?: KiloClawCommitRetirementQualificationSource | null;
}): KiloClawCommitInvoiceAuthorization {
  const periodStart = timestampMillis(input.invoicePeriodStart);
  const periodEnd = timestampMillis(input.invoicePeriodEnd);
  if (periodEnd <= periodStart) return 'ambiguous';

  if (input.commitEndsAt) {
    const commitEndsAt = timestampMillis(input.commitEndsAt);
    if (periodEnd === commitEndsAt) return 'authorized_final_term';
    if (periodStart >= commitEndsAt) return 'forbidden_renewal';
    return 'ambiguous';
  }
  if (periodStart < timestampMillis(KILOCLAW_COMMIT_SALES_CUTOFF)) return 'pre_cutoff_recovery';
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
  commitEndsAt: Timestamp;
  cancelAtPeriodEnd: boolean;
  hasStandardConsent: boolean;
}): boolean {
  if (input.cancelAtPeriodEnd || input.hasStandardConsent) return false;
  const now = timestampMillis(input.now);
  const commitEndsAt = timestampMillis(input.commitEndsAt);
  return now < commitEndsAt && now >= commitEndsAt - STRIPE_GUARD_LEAD_MS;
}

export function getKiloClawCommitUserFacingRetirementState(
  evidence: KiloClawCommitRetirementEvidence
): KiloClawCommitUserFacingRetirementState {
  const classification = classifyKiloClawCommitTerm(evidence);
  if (classification === 'ambiguous') return 'manual_review';
  if (classification === 'pending_final_term') return 'pending_final_term';
  if (classification === 'not_involved') return 'not_involved';
  return hasStandardConsent(evidence) ? 'standard_scheduled' : 'final_term_cancels';
}

function hasStandardConsent(evidence: KiloClawCommitRetirementEvidence): boolean {
  return (
    evidence.hasStandardConsent === true ||
    (evidence.scheduledPlan === KiloClawScheduledPlan.Standard &&
      evidence.scheduledBy === KiloClawScheduledBy.User)
  );
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

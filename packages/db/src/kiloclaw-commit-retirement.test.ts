import { describe, expect, it } from '@jest/globals';

import {
  KILOCLAW_COMMIT_SALES_CUTOFF,
  classifyKiloClawCommitInvoice,
  classifyKiloClawCommitTerm,
  deriveKiloClawCommitFinalBoundary,
  getKiloClawCommitUserFacingRetirementState,
  isBeforeKiloClawCommitSalesCutoff,
  isKiloClawCommitStripeGuardDue,
  maySelectKiloClawCommit,
} from './kiloclaw-commit-retirement';
import {
  KiloClawCommitRetirementQualificationSource,
  KiloClawCommitRetirementState,
  KiloClawPlan,
  KiloClawScheduledPlan,
} from './schema-types';

describe('KiloClaw Commit retirement policy', () => {
  it('enforces exclusive cutoff boundary', () => {
    expect(maySelectKiloClawCommit('2026-06-05T23:59:59.999Z')).toBe(true);
    expect(maySelectKiloClawCommit(KILOCLAW_COMMIT_SALES_CUTOFF)).toBe(false);
    expect(isBeforeKiloClawCommitSalesCutoff('2026-06-06T00:00:00.001Z')).toBe(false);
  });

  it('classifies active-at-cutoff and qualified pending final terms', () => {
    expect(
      classifyKiloClawCommitTerm({
        plan: KiloClawPlan.Commit,
        currentPeriodStart: '2026-05-01T00:00:00.000Z',
        currentPeriodEnd: '2026-11-01T00:00:00.000Z',
      })
    ).toBe('final_term');

    expect(
      classifyKiloClawCommitTerm({
        plan: KiloClawPlan.Standard,
        scheduledPlan: KiloClawScheduledPlan.Commit,
        retirementState: KiloClawCommitRetirementState.PendingFinalTerm,
        qualifiedAt: '2026-06-05T23:59:59.999Z',
        qualificationSource:
          KiloClawCommitRetirementQualificationSource.SwitchRequestedBeforeCutoff,
      })
    ).toBe('pending_final_term');
  });

  it('keeps durable pending-final classification after schedule tracking clears', () => {
    const durablePendingEvidence = {
      plan: KiloClawPlan.Standard,
      retirementState: KiloClawCommitRetirementState.PendingFinalTerm,
      qualifiedAt: '2026-06-05T23:59:59.999Z',
      qualificationSource: KiloClawCommitRetirementQualificationSource.SwitchRequestedBeforeCutoff,
    } as const;

    expect(classifyKiloClawCommitTerm(durablePendingEvidence)).toBe('pending_final_term');
    expect(
      classifyKiloClawCommitTerm({
        ...durablePendingEvidence,
        scheduledPlan: KiloClawScheduledPlan.Standard,
      })
    ).toBe('ambiguous');
  });

  it('trusts complete durable states and rejects conflicting persisted evidence', () => {
    expect(
      classifyKiloClawCommitTerm({
        plan: KiloClawPlan.Commit,
        retirementState: KiloClawCommitRetirementState.FinalTerm,
        finalEndsAt: '2026-11-01T00:00:00.000Z',
      })
    ).toBe('final_term');

    expect(
      classifyKiloClawCommitTerm({
        plan: KiloClawPlan.Commit,
        retirementState: KiloClawCommitRetirementState.StandardScheduled,
        finalEndsAt: '2026-11-01T00:00:00.000Z',
        standardOptedInAt: '2026-06-07T00:00:00.000Z',
      })
    ).toBe('final_term');

    expect(
      classifyKiloClawCommitTerm({
        plan: KiloClawPlan.Commit,
        retirementState: KiloClawCommitRetirementState.StandardScheduled,
        finalEndsAt: '2026-11-01T00:00:00.000Z',
        qualifiedAt: '2026-05-01T00:00:00.000Z',
        qualificationSource: KiloClawCommitRetirementQualificationSource.ActiveAtCutoff,
      })
    ).toBe('ambiguous');

    expect(
      classifyKiloClawCommitTerm({
        plan: KiloClawPlan.Commit,
        retirementState: KiloClawCommitRetirementState.FinalTerm,
        finalEndsAt: '2026-11-01T00:00:00.000Z',
        qualifiedAt: '2026-05-01T00:00:00.000Z',
        qualificationSource: KiloClawCommitRetirementQualificationSource.ActiveAtCutoff,
      })
    ).toBe('final_term');

    expect(
      classifyKiloClawCommitTerm({
        plan: KiloClawPlan.Commit,
        retirementState: KiloClawCommitRetirementState.FinalTerm,
        finalEndsAt: '2026-11-01T00:00:00.000Z',
        qualifiedAt: KILOCLAW_COMMIT_SALES_CUTOFF,
        qualificationSource: KiloClawCommitRetirementQualificationSource.ActiveAtCutoff,
      })
    ).toBe('ambiguous');
  });

  it('treats unqualified post-cutoff Commit terms as ambiguous', () => {
    expect(
      classifyKiloClawCommitTerm({
        plan: KiloClawPlan.Commit,
        currentPeriodStart: KILOCLAW_COMMIT_SALES_CUTOFF,
        currentPeriodEnd: '2026-12-06T00:00:00.000Z',
      })
    ).toBe('ambiguous');
  });

  it('requires local or provider evidence for a durable final boundary', () => {
    expect(
      deriveKiloClawCommitFinalBoundary({
        durableFinalEndsAt: '2026-11-01T00:00:00.000Z',
      })
    ).toEqual({ kind: 'missing' });
  });

  it('requires matching local and provider evidence for final boundary', () => {
    expect(
      deriveKiloClawCommitFinalBoundary({
        localPeriodEndsAt: '2026-11-01T00:00:00.000Z',
        providerPeriodEndsAt: '2026-11-01T00:00:00.000Z',
      })
    ).toEqual({ kind: 'verified', finalEndsAt: '2026-11-01T00:00:00.000Z' });

    expect(
      deriveKiloClawCommitFinalBoundary({ localPeriodEndsAt: '2026-11-01T00:00:00.000Z' })
    ).toEqual({ kind: 'missing' });
    expect(
      deriveKiloClawCommitFinalBoundary({
        localPeriodEndsAt: '2026-11-01T00:00:00.000Z',
        allowLocalOnly: true,
      })
    ).toEqual({ kind: 'verified', finalEndsAt: '2026-11-01T00:00:00.000Z' });

    expect(
      deriveKiloClawCommitFinalBoundary({
        localPeriodEndsAt: '2026-11-01T00:00:00.000Z',
        providerPeriodEndsAt: '2026-12-01T00:00:00.000Z',
      })
    ).toEqual({
      kind: 'conflicting',
      localEndsAt: '2026-11-01T00:00:00.000Z',
      providerEndsAt: '2026-12-01T00:00:00.000Z',
    });
  });

  it('classifies authorized final invoices, pre-cutoff recovery, and forbidden renewal', () => {
    expect(
      classifyKiloClawCommitInvoice({
        invoicePeriodStart: '2026-06-01T00:00:00.000Z',
        invoicePeriodEnd: '2026-12-01T00:00:00.000Z',
        finalEndsAt: '2026-12-01T00:00:00.000Z',
      })
    ).toBe('authorized_final_term');

    expect(
      classifyKiloClawCommitInvoice({
        invoicePeriodStart: '2026-06-05T00:00:00.000Z',
        invoicePeriodEnd: '2026-12-05T00:00:00.000Z',
      })
    ).toBe('pre_cutoff_recovery');

    expect(
      classifyKiloClawCommitInvoice({
        invoicePeriodStart: KILOCLAW_COMMIT_SALES_CUTOFF,
        invoicePeriodEnd: '2026-12-06T00:00:00.000Z',
      })
    ).toBe('forbidden_renewal');
  });

  it('starts Stripe guard exactly 30 days before final boundary', () => {
    const finalEndsAt = '2026-11-01T00:00:00.000Z';
    expect(isKiloClawCommitStripeGuardDue({ now: '2026-10-01T23:59:59.999Z', finalEndsAt })).toBe(
      false
    );
    expect(isKiloClawCommitStripeGuardDue({ now: '2026-10-02T00:00:00.000Z', finalEndsAt })).toBe(
      true
    );
    expect(
      isKiloClawCommitStripeGuardDue({
        now: '2026-10-02T00:00:00.000Z',
        finalEndsAt,
        standardOptedInAt: '2026-09-01T00:00:00.000Z',
      })
    ).toBe(false);
  });

  it('derives user-facing state without mutation', () => {
    expect(
      getKiloClawCommitUserFacingRetirementState({
        plan: KiloClawPlan.Commit,
        currentPeriodStart: '2026-05-01T00:00:00.000Z',
        currentPeriodEnd: '2026-11-01T00:00:00.000Z',
      })
    ).toBe('final_term_cancels');

    expect(
      getKiloClawCommitUserFacingRetirementState({
        plan: KiloClawPlan.Commit,
        retirementState: KiloClawCommitRetirementState.StandardScheduled,
        finalEndsAt: '2026-11-01T00:00:00.000Z',
        standardOptedInAt: '2026-06-07T00:00:00.000Z',
        qualifiedAt: '2026-05-01T00:00:00.000Z',
        qualificationSource: KiloClawCommitRetirementQualificationSource.ActiveAtCutoff,
      })
    ).toBe('standard_scheduled');
  });
});

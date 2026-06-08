import { describe, expect, it } from '@jest/globals';

import {
  KILOCLAW_COMMIT_SALES_CUTOFF,
  KiloClawCommitRetirementQualificationSource,
  classifyKiloClawCommitInvoice,
  classifyKiloClawCommitTerm,
  deriveKiloClawCommitFinalBoundary,
  getKiloClawCommitUserFacingRetirementState,
  isBeforeKiloClawCommitSalesCutoff,
  isKiloClawCommitStripeGuardDue,
  maySelectKiloClawCommit,
} from './kiloclaw-commit-retirement';
import { KiloClawPlan, KiloClawScheduledBy, KiloClawScheduledPlan } from './schema-types';

const finalCommit = {
  plan: KiloClawPlan.Commit,
  currentPeriodStart: '2026-05-01T00:00:00.000Z',
  currentPeriodEnd: '2026-11-01T00:00:00.000Z',
  commitEndsAt: '2026-11-01T00:00:00.000Z',
} as const;

describe('KiloClaw Commit retirement policy', () => {
  it('enforces exclusive cutoff boundary', () => {
    expect(maySelectKiloClawCommit('2026-06-05T23:59:59.999Z')).toBe(true);
    expect(maySelectKiloClawCommit(KILOCLAW_COMMIT_SALES_CUTOFF)).toBe(false);
    expect(isBeforeKiloClawCommitSalesCutoff('2026-06-06T00:00:00.001Z')).toBe(false);
  });

  it('classifies final and qualified pending terms from operational evidence', () => {
    expect(classifyKiloClawCommitTerm(finalCommit)).toBe('final_term');
    expect(
      classifyKiloClawCommitTerm({
        plan: KiloClawPlan.Standard,
        scheduledPlan: KiloClawScheduledPlan.Commit,
        qualifiedAt: '2026-06-05T23:59:59.999Z',
        qualificationSource:
          KiloClawCommitRetirementQualificationSource.SwitchRequestedBeforeCutoff,
      })
    ).toBe('pending_final_term');
  });

  it('fails closed for missing or mismatched boundaries', () => {
    expect(classifyKiloClawCommitTerm({ ...finalCommit, commitEndsAt: null })).toBe('ambiguous');
    expect(
      classifyKiloClawCommitTerm({
        ...finalCommit,
        currentPeriodEnd: '2026-12-01T00:00:00.000Z',
      })
    ).toBe('ambiguous');
  });

  it('uses commit_ends_at as canonical final boundary', () => {
    expect(
      deriveKiloClawCommitFinalBoundary({
        commitEndsAt: finalCommit.commitEndsAt,
        currentPeriodEndsAt: finalCommit.currentPeriodEnd,
        providerPeriodEndsAt: finalCommit.currentPeriodEnd,
      })
    ).toEqual({ kind: 'verified', finalEndsAt: finalCommit.commitEndsAt });
    expect(
      deriveKiloClawCommitFinalBoundary({
        commitEndsAt: finalCommit.commitEndsAt,
        currentPeriodEndsAt: finalCommit.currentPeriodEnd,
      })
    ).toEqual({ kind: 'missing' });
    expect(
      deriveKiloClawCommitFinalBoundary({
        commitEndsAt: finalCommit.commitEndsAt,
        currentPeriodEndsAt: finalCommit.currentPeriodEnd,
        allowLocalOnly: true,
      })
    ).toEqual({ kind: 'verified', finalEndsAt: finalCommit.commitEndsAt });
    expect(
      deriveKiloClawCommitFinalBoundary({
        commitEndsAt: finalCommit.commitEndsAt,
        currentPeriodEndsAt: finalCommit.currentPeriodEnd,
        providerPeriodEndsAt: '2026-12-01T00:00:00.000Z',
      })
    ).toEqual({
      kind: 'conflicting',
      localEndsAt: finalCommit.currentPeriodEnd,
      providerEndsAt: '2026-12-01T00:00:00.000Z',
    });
  });

  it('classifies invoice authorization against commit_ends_at', () => {
    expect(
      classifyKiloClawCommitInvoice({
        invoicePeriodStart: '2026-06-01T00:00:00.000Z',
        invoicePeriodEnd: '2026-12-01T00:00:00.000Z',
        commitEndsAt: '2026-12-01T00:00:00.000Z',
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

  it('starts guard exactly 30 days before boundary unless canceled or continuing', () => {
    const input = {
      commitEndsAt: finalCommit.commitEndsAt,
      cancelAtPeriodEnd: false,
      hasStandardConsent: false,
    };
    expect(isKiloClawCommitStripeGuardDue({ ...input, now: '2026-10-01T23:59:59.999Z' })).toBe(
      false
    );
    expect(isKiloClawCommitStripeGuardDue({ ...input, now: '2026-10-02T00:00:00.000Z' })).toBe(
      true
    );
    expect(
      isKiloClawCommitStripeGuardDue({
        ...input,
        now: '2026-10-02T00:00:00.000Z',
        cancelAtPeriodEnd: true,
      })
    ).toBe(false);
  });

  it('derives Standard consent from user-scheduled Standard', () => {
    expect(getKiloClawCommitUserFacingRetirementState(finalCommit)).toBe('final_term_cancels');
    expect(
      getKiloClawCommitUserFacingRetirementState({
        ...finalCommit,
        scheduledPlan: KiloClawScheduledPlan.Standard,
        scheduledBy: KiloClawScheduledBy.User,
      })
    ).toBe('standard_scheduled');
  });
});

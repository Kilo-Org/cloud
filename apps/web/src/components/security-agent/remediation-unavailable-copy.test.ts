import { describe, expect, it } from '@jest/globals';
import { SECURITY_REMEDIATION_ADMISSION_REJECTION_REASONS } from '@kilocode/worker-utils/security-remediation-policy';
import {
  getRemediationUnavailableCopy,
  isCodebaseAnalysisRequiredReason,
} from './remediation-unavailable-copy';

describe('getRemediationUnavailableCopy', () => {
  it('has dedicated copy for every admission rejection reason', () => {
    // Replaces the Record<SecurityRemediationAdmissionRejectionReason, string>
    // typing the pre-shared module had: a new rejection reason must get copy
    // in @kilocode/app-shared instead of silently degrading to the fallback.
    for (const reason of SECURITY_REMEDIATION_ADMISSION_REJECTION_REASONS) {
      expect(getRemediationUnavailableCopy(reason)).not.toBe(
        'Remediation is unavailable for this finding.'
      );
    }
  });

  it('turns typed admission reasons into actionable remediation copy', () => {
    expect(getRemediationUnavailableCopy('analysis_required')).toBe(
      'Run codebase analysis before starting remediation.'
    );
    expect(getRemediationUnavailableCopy('finding_not_found')).toBe(
      'Security finding no longer exists.'
    );
    expect(getRemediationUnavailableCopy('not_exploitable')).toBe(
      'Analysis found no reachable vulnerable path. Auto Remediation is unavailable.'
    );
    expect(getRemediationUnavailableCopy('action_not_concrete')).toBe(
      'No concrete dependency patch or suggested fix is available.'
    );
  });
});

describe('isCodebaseAnalysisRequiredReason', () => {
  it('classifies only missing codebase analysis as requiring analysis', () => {
    expect(isCodebaseAnalysisRequiredReason('analysis_required')).toBe(true);
    expect(isCodebaseAnalysisRequiredReason('sandbox_analysis_required')).toBe(true);
    expect(isCodebaseAnalysisRequiredReason('triage_only')).toBe(true);
    expect(isCodebaseAnalysisRequiredReason('not_exploitable')).toBe(false);
    expect(isCodebaseAnalysisRequiredReason('stale_analysis')).toBe(false);
    expect(isCodebaseAnalysisRequiredReason('finding_not_open')).toBe(false);
  });
});

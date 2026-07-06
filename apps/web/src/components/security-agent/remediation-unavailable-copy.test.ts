import { describe, expect, it } from '@jest/globals';
import {
  getRemediationUnavailableCopy,
  isCodebaseAnalysisRequiredReason,
} from './remediation-unavailable-copy';

describe('getRemediationUnavailableCopy', () => {
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

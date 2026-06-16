import { describe, expect, it } from '@jest/globals';
import { getRemediationUnavailableCopy } from './remediation-unavailable-copy';

describe('getRemediationUnavailableCopy', () => {
  it('turns typed admission reasons into actionable remediation copy', () => {
    expect(getRemediationUnavailableCopy('analysis_required')).toBe(
      'Run codebase analysis before starting remediation.'
    );
    expect(getRemediationUnavailableCopy('finding_not_found')).toBe(
      'Security finding no longer exists.'
    );
  });
});

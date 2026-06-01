import { describe, expect, test } from '@jest/globals';
import { manualAnalysisAdmissionCopy } from './manual-analysis-admission-copy';

describe('manualAnalysisAdmissionCopy', () => {
  test('describes manual analysis as queued admission', () => {
    expect(manualAnalysisAdmissionCopy.successTitle).toMatch(/queued/i);
    expect(manualAnalysisAdmissionCopy.failureTitle).toMatch(/failed to queue/i);
    expect(manualAnalysisAdmissionCopy.pendingLabel).toMatch(/queue/i);
  });
});

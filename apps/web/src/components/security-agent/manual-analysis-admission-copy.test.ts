import { describe, expect, test } from '@jest/globals';
import {
  isAwaitingManualAnalysisAdmission,
  manualAnalysisAdmissionCopy,
} from './manual-analysis-admission-copy';

describe('manualAnalysisAdmissionCopy', () => {
  test('describes manual analysis as queued admission', () => {
    expect(manualAnalysisAdmissionCopy.successTitle).toMatch(/queued/i);
    expect(manualAnalysisAdmissionCopy.failureTitle).toMatch(/failed to queue/i);
    expect(manualAnalysisAdmissionCopy.pendingLabel).toMatch(/queue/i);
  });

  test('stops showing admission progress after analysis is persisted as active', () => {
    expect(isAwaitingManualAnalysisAdmission(true, null)).toBe(true);
    expect(isAwaitingManualAnalysisAdmission(true, 'failed')).toBe(true);
    expect(isAwaitingManualAnalysisAdmission(true, 'completed')).toBe(true);
    expect(isAwaitingManualAnalysisAdmission(true, 'pending')).toBe(false);
    expect(isAwaitingManualAnalysisAdmission(true, 'running')).toBe(false);
    expect(isAwaitingManualAnalysisAdmission(false, null)).toBe(false);
  });
});

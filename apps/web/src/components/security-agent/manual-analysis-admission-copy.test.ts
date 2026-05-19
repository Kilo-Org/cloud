import { describe, expect, test } from '@jest/globals';
import { manualAnalysisAdmissionCopy } from './manual-analysis-admission-copy';

describe('manualAnalysisAdmissionCopy', () => {
  test('describes manual analysis as queued admission', () => {
    expect(manualAnalysisAdmissionCopy).toEqual({
      successTitle: 'Analysis queued',
      failureTitle: 'Failed to queue analysis',
      pendingLabel: 'Queueing',
    });
  });
});

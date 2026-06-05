import { describe, expect, it } from '@jest/globals';
import { getOperationalFailureStats } from './health-summary';

describe('getOperationalFailureStats', () => {
  it('calculates operational failure percentage without counting interruptions', () => {
    expect(
      getOperationalFailureStats({
        completedRuns: 90,
        failedRuns: 7,
        setupFailures: 3,
        interruptedRuns: 25,
      })
    ).toEqual({ failureEvents: 10, assessedOutcomes: 100, failureRatePercent: 10 });
  });

  it('does not report a percentage when no operational outcomes were assessed', () => {
    expect(
      getOperationalFailureStats({
        completedRuns: 0,
        failedRuns: 0,
        setupFailures: 0,
        interruptedRuns: 4,
      })
    ).toEqual({ failureEvents: 0, assessedOutcomes: 0, failureRatePercent: null });
  });
});

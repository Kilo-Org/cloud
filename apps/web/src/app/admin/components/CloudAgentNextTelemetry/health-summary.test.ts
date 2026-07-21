import { describe, expect, it } from '@jest/globals';
import {
  DEFAULT_FAILURE_RESPONSIBILITY_FILTER,
  failureReasonLabel,
  getObservedHealthStats,
  getOperationalFailureStats,
  hasExhaustiveFailureReasonLabels,
} from './health-summary';
import { CLOUD_AGENT_FAILURE_REASONS } from '@kilocode/worker-utils/cloud-agent-failure';

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

describe('failure responsibility summary', () => {
  it('defaults the operational table to platform failures', () => {
    expect(DEFAULT_FAILURE_RESPONSIBILITY_FILTER).toBe('platform');
  });

  it('uses all observed outcomes as the shared percentage denominator', () => {
    const stats = getObservedHealthStats({
      completedRuns: 16,
      failedRuns: 17,
      setupFailures: 3,
      interruptedRuns: 2,
      platformFailures: 9,
      userFailures: 6,
      unknownFailures: 5,
    });

    expect(stats.observedOutcomes).toBe(38);
    expect(stats.observedRuns).toBe(35);
    expect(stats.setupFailures).toBe(3);
    expect(stats.outcomes.map(outcome => [outcome.kind, outcome.count])).toEqual([
      ['completed', 16],
      ['interrupted', 2],
      ['user', 6],
      ['platform', 9],
      ['unknown', 5],
    ]);
    expect(
      stats.outcomes.reduce((total, outcome) => total + (outcome.sharePercent ?? 0), 0)
    ).toBeCloseTo(100);
    expect(stats.outcomes.find(outcome => outcome.kind === 'platform')?.sharePercent).toBeCloseTo(
      (9 / 38) * 100
    );
  });

  it('does not manufacture percentages when no outcomes were observed', () => {
    const stats = getObservedHealthStats({
      completedRuns: 0,
      failedRuns: 0,
      setupFailures: 0,
      interruptedRuns: 0,
      platformFailures: 0,
      userFailures: 0,
      unknownFailures: 0,
    });

    expect(stats.observedOutcomes).toBe(0);
    expect(stats.observedRuns).toBe(0);
    expect(stats.outcomes.every(outcome => outcome.sharePercent === null)).toBe(true);
  });

  it('has a human-readable label for every shared reason', () => {
    expect(hasExhaustiveFailureReasonLabels()).toBe(true);
    expect(CLOUD_AGENT_FAILURE_REASONS.map(failureReasonLabel)).not.toContain('');
    expect(failureReasonLabel('unclassified')).toBe('Unclassified');
  });
});
